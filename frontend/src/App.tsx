import { useState, useEffect, useCallback } from "react";
import * as api from "./api";
import { DeviceSelector } from "./components/DeviceSelector";
import { DateRangePicker } from "./components/DateRangePicker";
import { EventsTable } from "./components/EventsTable";
import { JobsPanel } from "./components/JobsPanel";

export default function App() {
  const [status, setStatus] = useState<api.ConnectionStatus | null>(null);
  const [devices, setDevices] = useState<api.SimpleDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [events, setEvents] = useState<api.EventRecord[]>([]);
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(
    new Set()
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tfaCode, setTfaCode] = useState("");
  const [captchaCode, setCaptchaCode] = useState("");

  // Poll connection status
  useEffect(() => {
    const poll = async () => {
      try {
        const s = await api.getStatus();
        setStatus(s);
      } catch {
        // Server not reachable
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);

  // Load devices when connected
  useEffect(() => {
    if (status?.status === "connected") {
      api
        .getDevices()
        .then((res) => setDevices(res.devices))
        .catch((err) => setError(err.message));
    }
  }, [status?.status]);

  const loadEvents = useCallback(async () => {
    if (!selectedDevice || !from || !to) {
      setError("Please select a device and date range");
      return;
    }
    setLoading(true);
    setError(null);
    setEvents([]);
    setSelectedEventIds(new Set());
    try {
      const res = await api.getEvents(selectedDevice, from, to);
      setEvents(res.events);
      // Select all by default
      setSelectedEventIds(new Set(res.events.map((e) => e.id)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setLoading(false);
    }
  }, [selectedDevice, from, to]);

  const handleDownload = useCallback(async () => {
    if (selectedEventIds.size === 0) {
      setError("No events selected");
      return;
    }
    setError(null);
    try {
      const result = await api.startDownload(
        selectedDevice,
        from,
        to,
        Array.from(selectedEventIds)
      );
      setError(null);
      alert(`Download job started: ${result.jobId}`);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to start download"
      );
    }
  }, [selectedDevice, from, to, selectedEventIds]);

  const handleTfaSubmit = async () => {
    try {
      await api.submitTfa(tfaCode);
      setTfaCode("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "2FA failed");
    }
  };

  const handleCaptchaSubmit = async () => {
    if (!status?.captcha) return;
    try {
      await api.submitCaptcha(status.captcha.id, captchaCode);
      setCaptchaCode("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Captcha failed");
    }
  };

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "1.5rem" }}>
      <h1>Eufy Bulk Downloader</h1>

      {/* Connection Status */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <strong>Connection:</strong>
          <span className={`status-badge ${status?.status || "disconnected"}`}>
            {status?.status || "checking..."}
          </span>
          {status?.error && (
            <span className="error-text">{status.error}</span>
          )}
        </div>

        {/* 2FA input */}
        {status?.status === "tfa_required" && (
          <div style={{ marginTop: "0.75rem" }}>
            <p>A 2FA verification code has been sent to your email/phone.</p>
            <div className="row">
              <div className="field">
                <label>Verification Code</label>
                <input
                  type="text"
                  maxLength={6}
                  placeholder="123456"
                  value={tfaCode}
                  onChange={(e) => setTfaCode(e.target.value)}
                />
              </div>
              <button className="primary" onClick={handleTfaSubmit}>
                Submit
              </button>
            </div>
          </div>
        )}

        {/* Captcha input */}
        {status?.status === "captcha_required" && status.captcha && (
          <div style={{ marginTop: "0.75rem" }}>
            <p>Please solve the captcha to continue.</p>
            <img
              src={`data:image/png;base64,${status.captcha.imageBase64}`}
              alt="Captcha"
              style={{ marginBottom: "0.5rem", border: "1px solid #ccc" }}
            />
            <div className="row">
              <div className="field">
                <label>Captcha Code</label>
                <input
                  type="text"
                  value={captchaCode}
                  onChange={(e) => setCaptchaCode(e.target.value)}
                />
              </div>
              <button className="primary" onClick={handleCaptchaSubmit}>
                Submit
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Only show controls when connected */}
      {status?.status === "connected" && (
        <>
          {/* Device & Date Selection */}
          <div className="card">
            <h2>Select Device & Date Range</h2>
            <div className="row">
              <DeviceSelector
                devices={devices}
                value={selectedDevice}
                onChange={setSelectedDevice}
              />
              <DateRangePicker
                from={from}
                to={to}
                onFromChange={setFrom}
                onToChange={setTo}
              />
              <button
                className="primary"
                onClick={loadEvents}
                disabled={loading}
              >
                {loading ? "Loading..." : "Load Events"}
              </button>
            </div>
          </div>

          {/* Error display */}
          {error && (
            <div className="card">
              <p className="error-text">{error}</p>
            </div>
          )}

          {/* Events Table */}
          {events.length > 0 && (
            <div className="card">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "0.75rem",
                }}
              >
                <h2>
                  Events ({selectedEventIds.size} / {events.length} selected)
                </h2>
                <button
                  className="primary"
                  onClick={handleDownload}
                  disabled={selectedEventIds.size === 0}
                >
                  Download Selected
                </button>
              </div>
              <EventsTable
                events={events}
                selectedIds={selectedEventIds}
                onSelectionChange={setSelectedEventIds}
              />
            </div>
          )}

          {/* Jobs Panel */}
          <JobsPanel />
        </>
      )}
    </div>
  );
}
