import { useState, useEffect } from "react";
import * as api from "../api";

export function JobsPanel() {
  const [jobs, setJobs] = useState<api.DownloadJob[]>([]);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await api.getJobs();
        setJobs(res.jobs);
      } catch {
        // ignore
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, []);

  if (jobs.length === 0) return null;

  return (
    <div className="card">
      <h2>Download Jobs</h2>
      {jobs.map((job) => {
        const done = job.events.filter((e) => e.status === "done").length;
        const failed = job.events.filter((e) => e.status === "failed").length;
        const total = job.events.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;

        return (
          <div
            key={job.id}
            style={{
              borderBottom: "1px solid #e5e5e5",
              padding: "0.75rem 0",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <strong>{job.deviceName}</strong>
                <span style={{ marginLeft: "0.5rem", fontSize: "0.85rem", color: "#666" }}>
                  {new Date(job.from).toLocaleDateString()} -{" "}
                  {new Date(job.to).toLocaleDateString()}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span className={`status-badge ${job.status}`}>
                  {job.status}
                </span>
                {job.status === "running" && (
                  <button
                    className="danger"
                    style={{ padding: "0.25rem 0.5rem", fontSize: "0.8rem" }}
                    onClick={() => api.cancelJob(job.id)}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
            <div
              style={{
                fontSize: "0.85rem",
                color: "#666",
                marginTop: "0.25rem",
              }}
            >
              {done} / {total} downloaded
              {failed > 0 && (
                <span style={{ color: "#dc2626" }}> ({failed} failed)</span>
              )}
            </div>
            <div className="progress-bar">
              <div className="fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
