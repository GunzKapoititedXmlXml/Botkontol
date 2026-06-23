const fs = require("fs");
const path = require("path");

const JOBS_FILE = "./active_jobs.json";

// ─── ENSURE FILE ──────────────────────────────────────────────────────────────
function ensureJobsFile() {
  if (!fs.existsSync(JOBS_FILE)) {
    fs.writeFileSync(JOBS_FILE, JSON.stringify({}, null, 2));
  }
}
ensureJobsFile();

// ─── GET ALL JOBS ─────────────────────────────────────────────────────────────
function getAllJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveAllJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

// ─── USER JOB ─────────────────────────────────────────────────────────────────
function getUserJob(userId) {
  const jobs = getAllJobs();
  return jobs[String(userId)] || null;
}

function setUserJob(userId, jobData) {
  const jobs = getAllJobs();
  jobs[String(userId)] = jobData;
  saveAllJobs(jobs);
}

function removeUserJob(userId) {
  const jobs = getAllJobs();
  delete jobs[String(userId)];
  saveAllJobs(jobs);
}

function isUserBuilding(userId) {
  const job = getUserJob(userId);
  return job && job.status !== "completed" && job.status !== "failed";
}

// ─── ACTIVE JOBS ──────────────────────────────────────────────────────────────
function getActiveJobs() {
  const jobs = getAllJobs();
  const active = [];
  for (const [userId, job] of Object.entries(jobs)) {
    if (job.status !== "completed" && job.status !== "failed") {
      active.push({ userId: parseInt(userId), ...job });
    }
  }
  return active;
}

function getQueueStats() {
  const jobs = getActiveJobs();
  const stats = { waiting: 0, uploading: 0, building: 0 };
  for (const job of jobs) {
    if (job.status === "waiting_zip" || job.status === "waiting_url" || job.status === "waiting_appname" || job.status === "waiting_icon") {
      stats.waiting++;
    } else if (job.status === "uploading") {
      stats.uploading++;
    } else if (job.status === "building") {
      stats.building++;
    }
  }
  return stats;
}

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
function cleanupOldJobs(maxAgeMs = 3600000) {
  const jobs = getAllJobs();
  const now = Date.now();
  let changed = false;
  
  for (const [userId, job] of Object.entries(jobs)) {
    const updatedAt = job.updatedAt || 0;
    if (now - updatedAt > maxAgeMs) {
      delete jobs[userId];
      changed = true;
    }
  }
  
  if (changed) {
    saveAllJobs(jobs);
  }
}

module.exports = {
  getUserJob,
  setUserJob,
  removeUserJob,
  isUserBuilding,
  getActiveJobs,
  getQueueStats,
  cleanupOldJobs,
};