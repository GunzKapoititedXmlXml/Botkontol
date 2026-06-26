const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ─── KONFIGURASI SERVER ─────────────────────────────────────────────────────
const BUILD_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 5000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const GITHUB_API = "https://api.github.com";

// ─── MULTI TOKEN SUPPORT ──────────────────────────────────────────────────
const GITHUB_TOKENS = [
  "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",
  "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",
  "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", 
  "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", 
  "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"
];

// Pilih token random atau round-robin
let currentTokenIndex = 0;
function getNextToken() {
  const token = GITHUB_TOKENS[currentTokenIndex];
  currentTokenIndex = (currentTokenIndex + 1) % GITHUB_TOKENS.length;
  return token;
}

// Default pake token pertama
const GITHUB_TOKEN = GITHUB_TOKENS[0];

const REPO_OWNER = "GunzXmlkapotited";
const REPO_NAME = "Buildapp-Secondary";
const WORKFLOW_ID = "flutter-build.yml";
const BUILD_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 5000;

const SERVER_ID = "server3";
const SERVER_NAME = "Server 3 (Secondary)";
const SERVER_DESCRIPTION = "Server Secondary - Cepat";

// ─── COPY SEMUA FUNGSI DARI server1.js ──────────────────────────────────────
// (sama persis dengan server1.js, hanya beda konfigurasi di atas)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const GITHUB_API = "https://api.github.com";

const axiosGit = axios.create({
  baseURL: GITHUB_API,
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
  },
});

function repoPath(...segments) {
  return `/repos/${REPO_OWNER}/${REPO_NAME}/${segments.join("/")}`;
}

async function createReleaseOnly(tag) {
  try {
    const response = await axiosGit.post(repoPath("releases"), {
      tag_name: tag,
      name: `Build ${tag}`,
      draft: false,
      prerelease: false,
      generate_release_notes: false,
    });
    return {
      releaseId: response.data.id,
      uploadUrl: response.data.upload_url.replace("{?name,label}", ""),
      htmlUrl: response.data.html_url,
    };
  } catch (error) {
    console.error("❌ Error creating release:", error.response?.data || error.message);
    throw new Error(`Gagal membuat release: ${error.response?.data?.message || error.message}`);
  }
}

async function uploadAssetFile(uploadUrl, filePath, fileName, contentType) {
  try {
    const fileData = fs.readFileSync(filePath);
    const fileSize = fs.statSync(filePath).size;

    const response = await axios({
      method: "post",
      url: uploadUrl,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": contentType || "application/zip",
        "Content-Length": fileSize,
      },
      data: fileData,
      params: { name: fileName },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    return response.data.browser_download_url;
  } catch (error) {
    console.error("❌ Error uploading asset:", error.response?.data || error.message);
    throw new Error(`Gagal upload asset: ${error.response?.data?.message || error.message}`);
  }
}

async function uploadZipToRelease(zipPath, originalFileName, tag) {
  try {
    if (!fs.existsSync(zipPath)) {
      throw new Error(`File ZIP tidak ditemukan: ${zipPath}`);
    }

    console.log(`📦 [${SERVER_NAME}] Uploading ZIP to release: ${tag}`);
    
    const { releaseId, uploadUrl, htmlUrl } = await createReleaseOnly(tag);
    console.log(`✅ [${SERVER_NAME}] Release created: ${htmlUrl}`);

    const assetUrl = await uploadAssetFile(
      uploadUrl, 
      zipPath, 
      "project.zip",
      "application/zip"
    );

    console.log(`✅ [${SERVER_NAME}] Asset uploaded: ${assetUrl}`);

    return {
      releaseId,
      uploadUrl,
      htmlUrl,
      assetUrl,
      browserUrl: htmlUrl,
      downloadUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${tag}/project.zip`,
      serverId: SERVER_ID,
      serverName: SERVER_NAME,
    };
  } catch (error) {
    console.error("❌ Error uploading zip to release:", error);
    throw error;
  }
}

async function deleteRelease(releaseId) {
  if (!releaseId) return;
  try {
    await axiosGit.delete(repoPath(`releases/${releaseId}`));
    console.log(`🗑️ [${SERVER_NAME}] Release ${releaseId} deleted`);
  } catch (error) {
    console.error(`❌ Error deleting release ${releaseId}:`, error.response?.data || error.message);
  }
}

async function triggerWorkflow(browserUrl, tag, buildType) {
  try {
    console.log(`🚀 [${SERVER_NAME}] Triggering workflow for tag: ${tag}`);
    console.log(`📋 [${SERVER_NAME}] Release URL: ${browserUrl}`);
    
    const response = await axiosGit.post(
      repoPath(`actions/workflows/${WORKFLOW_ID}/dispatches`),
      {
        ref: "main",
        inputs: {
          release_url: browserUrl,
          tag: tag,
          build_type: buildType || "release",
        },
      }
    );

    const location = response.headers.location;
    if (location) {
      const runIdMatch = location.match(/\/actions\/runs\/(\d+)/);
      if (runIdMatch) {
        const runId = parseInt(runIdMatch[1]);
        console.log(`✅ [${SERVER_NAME}] Workflow triggered! Run ID: ${runId}`);
        return runId;
      }
    }

    const runs = await getWorkflowRuns(WORKFLOW_ID, 1);
    if (runs.length > 0) {
      console.log(`✅ [${SERVER_NAME}] Using latest run ID: ${runs[0].id}`);
      return runs[0].id;
    }

    throw new Error("Gagal mendapatkan run ID");
  } catch (error) {
    console.error("❌ Error triggering workflow:", error.response?.data || error.message);
    throw new Error(`Gagal trigger workflow: ${error.response?.data?.message || error.message}`);
  }
}

async function getWorkflowRuns(workflowId, limit = 5) {
  try {
    const response = await axiosGit.get(
      repoPath(`actions/workflows/${workflowId}/runs`),
      { params: { per_page: limit } }
    );
    return response.data.workflow_runs || [];
  } catch (error) {
    console.error("❌ Error getting workflow runs:", error.response?.data || error.message);
    return [];
  }
}

async function getRunStatus(runId) {
  try {
    const response = await axiosGit.get(repoPath(`actions/runs/${runId}`));
    const run = response.data;
    return {
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.html_url,
      durationSec: run.updated_at && run.created_at
        ? Math.floor((new Date(run.updated_at) - new Date(run.created_at)) / 1000)
        : 0,
      jobsUrl: run.jobs_url,
      serverId: SERVER_ID,
      serverName: SERVER_NAME,
    };
  } catch (error) {
    console.error("❌ Error getting run status:", error.response?.data || error.message);
    throw new Error(`Gagal dapat status run: ${error.response?.data?.message || error.message}`);
  }
}

async function getArtifacts(runId) {
  try {
    const response = await axiosGit.get(repoPath(`actions/runs/${runId}/artifacts`));
    return response.data.artifacts || [];
  } catch (error) {
    console.error("❌ Error getting artifacts:", error.response?.data || error.message);
    return [];
  }
}

async function downloadArtifactZip(artifactId, outputPath) {
  try {
    console.log(`⬇️ [${SERVER_NAME}] Downloading artifact ${artifactId}...`);
    const response = await axiosGit.get(
      repoPath(`actions/artifacts/${artifactId}/zip`),
      { responseType: "arraybuffer" }
    );
    fs.writeFileSync(outputPath, response.data);
    console.log(`✅ [${SERVER_NAME}] Artifact downloaded: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error("❌ Error downloading artifact:", error.response?.data || error.message);
    throw new Error(`Gagal download artifact: ${error.response?.data?.message || error.message}`);
  }
}

async function getFailedStepLog(runId) {
  try {
    const jobsResponse = await axiosGit.get(repoPath(`actions/runs/${runId}/jobs`));
    const jobs = jobsResponse.data.jobs || [];

    const failedJob = jobs.find(j => j.conclusion === "failure");
    if (!failedJob) {
      return null;
    }

    const steps = failedJob.steps || [];
    const failedStep = steps.find(s => s.conclusion === "failure");
    if (!failedStep) {
      return null;
    }

    const logResponse = await axiosGit.get(
      repoPath(`actions/jobs/${failedJob.id}/logs`),
      { responseType: "text" }
    );

    const logLines = logResponse.data.split("\n");
    const errorLines = [];

    let inFailedStep = false;
    let stepName = failedStep.name || "Unknown step";

    for (const line of logLines) {
      if (line.includes(`##[group]${stepName}`) || line.includes(`##[group]${failedStep.name}`)) {
        inFailedStep = true;
        continue;
      }
      if (line.includes("##[endgroup]")) {
        inFailedStep = false;
        continue;
      }
      if (inFailedStep && (line.includes("error") || line.includes("Error") || line.includes("ERROR") || line.includes("failed") || line.includes("Failed"))) {
        errorLines.push(line);
      }
    }

    if (errorLines.length === 0) {
      const allLines = logResponse.data.split("\n");
      const start = Math.max(0, allLines.length - 20);
      return {
        stepName: stepName,
        errorLines: allLines.slice(start),
        serverId: SERVER_ID,
        serverName: SERVER_NAME,
      };
    }

    return {
      stepName: stepName,
      errorLines: errorLines.slice(0, 50),
      serverId: SERVER_ID,
      serverName: SERVER_NAME,
    };
  } catch (error) {
    console.error("❌ Error getting failed step log:", error.message);
    return null;
  }
}

async function publishRelease(releaseId) {
  try {
    const response = await axiosGit.patch(repoPath(`releases/${releaseId}`), {
      draft: false,
    });
    return response.data.html_url;
  } catch (error) {
    console.error("❌ Error publishing release:", error.response?.data || error.message);
    throw new Error(`Gagal publish release: ${error.response?.data?.message || error.message}`);
  }
}

module.exports = {
  uploadZipToRelease,
  uploadAssetFile,
  createReleaseOnly,
  deleteRelease,
  publishRelease,
  triggerWorkflow,
  getWorkflowRuns,
  getRunStatus,
  getArtifacts,
  downloadArtifactZip,
  getFailedStepLog,
  sleep,
  SERVER_ID,
  SERVER_NAME,
  SERVER_DESCRIPTION,
  GITHUB_TOKEN,
  REPO_OWNER,
  REPO_NAME,
  WORKFLOW_ID,
  BUILD_TIMEOUT_MS,
  POLL_INTERVAL_MS,
};