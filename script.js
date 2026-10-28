
const $ = (selector) => document.querySelector(selector);

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function showNotice(message, isError = false) {
    const notice = $("#notice");
    notice.textContent = message;
    notice.classList.toggle("error", isError);
    notice.hidden = false;

    window.clearTimeout(showNotice.timer);
    showNotice.timer = window.setTimeout(() => {
        notice.hidden = true;
    }, 5000);
}

async function api(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
        ? await response.json()
        : {};

    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }

    return data;
}

function localDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

let students = [];
let sessions = [];

function renderStudents() {
    const tbody = $("#studentsTable");

    if (!students.length) {
        tbody.innerHTML =
            '<tr><td colspan="5" class="empty">No students registered yet.</td></tr>';
    } else {
        tbody.innerHTML = students.map((student) => `
            <tr>
                <td>${escapeHTML(student.student_id)}</td>
                <td>${escapeHTML(student.name)}</td>
                <td>${escapeHTML(student.class_name)}</td>
                <td>${escapeHTML(student.email || "—")}</td>
                <td>
                    <button class="delete-btn"
                        data-delete-student="${escapeHTML(student.student_id)}">
                        Delete
                    </button>
                </td>
            </tr>
        `).join("");
    }

    const select = $("#attendanceStudent");
    const previous = select.value;

    select.innerHTML =
        '<option value="">Select student</option>' +
        students.map((student) => `
            <option value="${escapeHTML(student.student_id)}">
                ${escapeHTML(student.name)} (${escapeHTML(student.student_id)})
                — ${escapeHTML(student.class_name)}
            </option>
        `).join("");

    if (students.some((student) => student.student_id === previous)) {
        select.value = previous;
    }
}

function renderSessions() {
    const container = $("#sessionsList");

    if (!sessions.length) {
        container.innerHTML =
            '<p class="empty">No sessions created yet.</p>';
    } else {
        container.innerHTML = sessions.map((session) => `
            <article class="session-card">
                <strong>${escapeHTML(session.title)}</strong>
                <span>Class: ${escapeHTML(session.class_name)}</span>
                <span>Date: ${escapeHTML(session.session_date)}</span>
            </article>
        `).join("");
    }

    const select = $("#attendanceSession");
    const previous = select.value;

    select.innerHTML =
        '<option value="">Select session</option>' +
        sessions.map((session) => `
            <option value="${escapeHTML(session._id)}">
                ${escapeHTML(session.title)} — ${escapeHTML(session.class_name)}
                (${escapeHTML(session.session_date)})
            </option>
        `).join("");

    if (sessions.some((session) => session._id === previous)) {
        select.value = previous;
    }
}

async function loadStats() {
    const stats = await api("/api/stats");

    $("#totalStudents").textContent = stats.students;
    $("#totalSessions").textContent = stats.sessions;
    $("#totalPresent").textContent = stats.present;
    $("#attendanceRate").textContent = `${stats.attendance_rate}%`;
}

async function loadStudents() {
    students = await api("/api/students");
    renderStudents();
}

async function loadSessions() {
    sessions = await api("/api/sessions");
    renderSessions();
}

async function loadAttendance() {
    const records = await api("/api/attendance");
    const tbody = $("#attendanceTable");

    if (!records.length) {
        tbody.innerHTML =
            '<tr><td colspan="5" class="empty">No attendance records yet.</td></tr>';
        return;
    }

    tbody.innerHTML = records.map((record) => {
        const statusClass = record.status.toLowerCase();
        const date = record.recorded_at
            ? new Date(record.recorded_at).toLocaleString()
            : "—";

        return `
            <tr>
                <td>${escapeHTML(record.student_name)}</td>
                <td>${escapeHTML(record.session_title)}</td>
                <td>${escapeHTML(record.class_name)}</td>
                <td><span class="badge ${escapeHTML(statusClass)}">
                    ${escapeHTML(record.status)}
                </span></td>
                <td>${escapeHTML(date)}</td>
            </tr>
        `;
    }).join("");
}

async function loadEngagement() {
    const data = await api("/api/engagement");
    $("#engagementTitle").textContent =
        data.status === "awaiting_validated_engagement_signals"
            ? "Engagement module ready for integration"
            : "Engagement overview";
    $("#engagementMessage").textContent = data.message;
}

async function refreshDashboard() {
    $("#refreshBtn").disabled = true;

    try {
        const health = await api("/api/health");
        $("#dbStatus").textContent = `MongoDB: ${health.mongodb}`;
        $(".status-dot").style.background = "#28c58b";

        await Promise.all([
            loadStats(),
            loadStudents(),
            loadSessions(),
            loadAttendance(),
            loadEngagement()
        ]);
    } catch (error) {
        $("#dbStatus").textContent = "Database unavailable";
        $(".status-dot").style.background = "#e05252";
        showNotice(error.message, true);
    } finally {
        $("#refreshBtn").disabled = false;
    }
}

$("#studentForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const payload = Object.fromEntries(formData.entries());

    try {
        await api("/api/students", {
            method: "POST",
            body: JSON.stringify(payload)
        });

        event.currentTarget.reset();
        showNotice("Student added successfully.");
        await refreshDashboard();
    } catch (error) {
        showNotice(error.message, true);
    }
});

$("#sessionForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const payload = Object.fromEntries(formData.entries());

    try {
        await api("/api/sessions", {
            method: "POST",
            body: JSON.stringify(payload)
        });

        event.currentTarget.reset();
        $("#sessionDate").value = localDate();
        showNotice("Session created successfully.");
        await refreshDashboard();
    } catch (error) {
        showNotice(error.message, true);
    }
});

$("#attendanceForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const payload = Object.fromEntries(formData.entries());

    try {
        await api("/api/attendance", {
            method: "POST",
            body: JSON.stringify(payload)
        });

        showNotice("Attendance saved successfully.");
        await refreshDashboard();
    } catch (error) {
        showNotice(error.message, true);
    }
});

$("#studentsTable").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-student]");
    if (!button) return;

    const studentId = button.dataset.deleteStudent;

    if (!window.confirm(`Delete student ${studentId}?`)) return;

    try {
        await api(`/api/students/${encodeURIComponent(studentId)}`, {
            method: "DELETE"
        });

        showNotice("Student deleted successfully.");
        await refreshDashboard();
    } catch (error) {
        showNotice(error.message, true);
    }
});

$("#refreshBtn").addEventListener("click", refreshDashboard);

document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => {
        document.querySelectorAll(".nav-link").forEach((item) => {
            item.classList.remove("active");
        });
        link.classList.add("active");
    });
});

$("#todayDate").textContent = new Date().toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric"
});

$("#sessionDate").value = localDate();

refreshDashboard();
