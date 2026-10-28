
import os
from datetime import datetime, timezone

from bson import ObjectId
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from pymongo import MongoClient, ASCENDING
from pymongo.errors import PyMongoError

load_dotenv()

app = Flask(__name__)

MONGODB_URI = os.getenv(
    "MONGODB_URI",
    "mongodb://127.0.0.1:27017/"
)
DATABASE_NAME = os.getenv("DATABASE_NAME", "attendance_agent")

client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=2500)
db = client[DATABASE_NAME]


def now_utc():
    return datetime.now(timezone.utc)


def serialize(document):
    """Convert MongoDB documents into JSON-safe dictionaries."""
    if not document:
        return document

    result = {}
    for key, value in document.items():
        if isinstance(value, ObjectId):
            result[key] = str(value)
        elif isinstance(value, datetime):
            result[key] = value.isoformat()
        else:
            result[key] = value
    return result


def error_response(message, status=400):
    return jsonify({"success": False, "error": message}), status


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/api/health")
def health():
    try:
        client.admin.command("ping")
        return jsonify({
            "success": True,
            "database": DATABASE_NAME,
            "mongodb": "connected"
        })
    except PyMongoError:
        return jsonify({
            "success": False,
            "mongodb": "disconnected",
            "message": "Check that MongoDB is running."
        }), 503


@app.get("/api/stats")
def get_stats():
    try:
        students = list(db.students.find({}, {"_id": 0}))
        sessions = list(db.sessions.find({}))
        records = list(db.attendance.find({}))

        present = sum(1 for r in records if r["status"] == "Present")
        absent = sum(1 for r in records if r["status"] == "Absent")
        late = sum(1 for r in records if r["status"] == "Late")

        marked = present + absent + late
        rate = round((present / marked) * 100, 1) if marked else 0

        return jsonify({
            "success": True,
            "students": len(students),
            "sessions": len(sessions),
            "present": present,
            "absent": absent,
            "late": late,
            "attendance_rate": rate
        })
    except PyMongoError:
        app.logger.exception("Could not load dashboard statistics")
        return error_response("MongoDB is unavailable.", 503)


@app.get("/api/students")
def get_students():
    try:
        items = list(db.students.find().sort("created_at", -1))
        return jsonify([serialize(item) for item in items])
    except PyMongoError:
        return error_response("Could not load students. Check MongoDB.", 503)


@app.post("/api/students")
def add_student():
    data = request.get_json(silent=True) or {}

    student_id = str(data.get("student_id", "")).strip()
    name = str(data.get("name", "")).strip()
    class_name = str(data.get("class_name", "")).strip()
    email = str(data.get("email", "")).strip()

    if not student_id or not name or not class_name:
        return error_response("Student ID, name and class are required.")

    if len(student_id) > 40 or len(name) > 100 or len(class_name) > 80:
        return error_response("One or more fields are too long.")

    try:
        if db.students.find_one({"student_id": student_id}):
            return error_response("This Student ID already exists.", 409)

        document = {
            "student_id": student_id,
            "name": name,
            "class_name": class_name,
            "email": email,
            "created_at": now_utc()
        }

        result = db.students.insert_one(document)
        document["_id"] = result.inserted_id

        return jsonify({
            "success": True,
            "student": serialize(document)
        }), 201
    except PyMongoError:
        app.logger.exception("Could not add student")
        return error_response("Could not save student to MongoDB.", 503)


@app.delete("/api/students/<student_id>")
def delete_student(student_id):
    try:
        student = db.students.find_one({"student_id": student_id})
        if not student:
            return error_response("Student not found.", 404)

        # Keep historical attendance intact.
        if db.attendance.find_one({"student_id": student_id}):
            return error_response(
                "This student has attendance history and cannot be deleted."
            )

        db.students.delete_one({"_id": student["_id"]})
        return jsonify({"success": True})
    except PyMongoError:
        return error_response("Could not delete student.", 503)


@app.get("/api/sessions")
def get_sessions():
    try:
        items = list(db.sessions.find().sort("created_at", -1))
        return jsonify([serialize(item) for item in items])
    except PyMongoError:
        return error_response("Could not load sessions.", 503)


@app.post("/api/sessions")
def add_session():
    data = request.get_json(silent=True) or {}

    title = str(data.get("title", "")).strip()
    class_name = str(data.get("class_name", "")).strip()
    session_date = str(data.get("session_date", "")).strip()

    if not title or not class_name or not session_date:
        return error_response("All session fields are required.")

    try:
        # Validate the supplied date.
        datetime.strptime(session_date, "%Y-%m-%d")

        document = {
            "title": title,
            "class_name": class_name,
            "session_date": session_date,
            "created_at": now_utc()
        }

        result = db.sessions.insert_one(document)
        document["_id"] = result.inserted_id

        return jsonify({
            "success": True,
            "session": serialize(document)
        }), 201
    except ValueError:
        return error_response("Date must use YYYY-MM-DD format.")
    except PyMongoError:
        app.logger.exception("Could not create session")
        return error_response("Could not save session.", 503)


@app.post("/api/attendance")
def mark_attendance():
    data = request.get_json(silent=True) or {}

    student_id = str(data.get("student_id", "")).strip()
    session_id = str(data.get("session_id", "")).strip()
    status = str(data.get("status", "")).strip().title()

    if not student_id or not session_id:
        return error_response("Select a student and a session.")

    if status not in {"Present", "Absent", "Late"}:
        return error_response("Status must be Present, Absent or Late.")

    try:
        if not ObjectId.is_valid(session_id):
            return error_response("Invalid session selected.")

        student = db.students.find_one({"student_id": student_id})
        session = db.sessions.find_one({"_id": ObjectId(session_id)})

        if not student:
            return error_response("Student not found.", 404)
        if not session:
            return error_response("Session not found.", 404)

        if student["class_name"] != session["class_name"]:
            return error_response(
                "Student and session must belong to the same class."
            )

        record = {
            "student_id": student_id,
            "student_name": student["name"],
            "session_id": session_id,
            "session_title": session["title"],
            "class_name": student["class_name"],
            "status": status,
            "recorded_at": now_utc()
        }

        db.attendance.update_one(
            {"student_id": student_id, "session_id": session_id},
            {"$set": record},
            upsert=True
        )

        return jsonify({"success": True, "record": record}), 201
    except PyMongoError:
        app.logger.exception("Could not mark attendance")
        return error_response("Could not save attendance.", 503)


@app.get("/api/attendance")
def get_attendance():
    try:
        items = list(db.attendance.find().sort("recorded_at", -1).limit(100))
        return jsonify([serialize(item) for item in items])
    except PyMongoError:
        return error_response("Could not load attendance.", 503)


@app.get("/api/engagement")
def get_engagement():
    """
    Initial engagement overview based on recorded attendance only.
    This is not camera-based attention detection.
    """
    try:
        records = list(db.attendance.find())
        total = len(records)

        return jsonify({
            "success": True,
            "records_analyzed": total,
            "message": (
                "Engagement analysis module is ready for integration. "
                "Attendance status alone does not measure attention."
            ),
            "status": "awaiting_validated_engagement_signals"
        })
    except PyMongoError:
        return error_response("Could not load engagement overview.", 503)


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"):
        return error_response("API endpoint not found.", 404)
    return "Page not found", 404


if __name__ == "__main__":
    try:
        db.students.create_index(
            [("student_id", ASCENDING)],
            unique=True
        )
        db.sessions.create_index([("session_date", ASCENDING)])
        db.attendance.create_index(
            [("student_id", ASCENDING), ("session_id", ASCENDING)],
            unique=True
        )
    except PyMongoError:
        app.logger.warning(
            "MongoDB is not available at startup; check /api/health."
        )

    app.run(debug=True)
