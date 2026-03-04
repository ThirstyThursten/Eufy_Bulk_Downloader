import type { EventRecord } from "../api";

interface Props {
  events: EventRecord[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
}

const VIDEO_TYPE_LABELS: Record<number, string> = {
  1000: "Ring",
  1001: "Missed Ring",
  1002: "Motion",
  1003: "Person",
  1004: "Pet",
  1005: "Crying",
  1006: "Sound",
};

function formatTimestamp(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

function formatDuration(startTime: number, endTime: number): string {
  const seconds = endTime - startTime;
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

export function EventsTable({ events, selectedIds, onSelectionChange }: Props) {
  const allSelected = events.length > 0 && selectedIds.size === events.length;

  const toggleAll = () => {
    if (allSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(events.map((e) => e.id)));
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectionChange(next);
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th style={{ width: 40 }}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
              />
            </th>
            <th>Time</th>
            <th>Duration</th>
            <th>Type</th>
            <th>Person</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>
                <input
                  type="checkbox"
                  checked={selectedIds.has(event.id)}
                  onChange={() => toggleOne(event.id)}
                />
              </td>
              <td>{formatTimestamp(event.startTime)}</td>
              <td>{formatDuration(event.startTime, event.endTime)}</td>
              <td>
                {VIDEO_TYPE_LABELS[event.videoType] || `Type ${event.videoType}`}
              </td>
              <td>{event.hasHuman ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
