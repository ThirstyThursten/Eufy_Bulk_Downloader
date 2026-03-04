interface Props {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}

export function DateRangePicker({
  from,
  to,
  onFromChange,
  onToChange,
}: Props) {
  return (
    <>
      <div className="field">
        <label>From</label>
        <input
          type="datetime-local"
          value={from ? toLocalInput(from) : ""}
          onChange={(e) => onFromChange(toIso(e.target.value))}
        />
      </div>
      <div className="field">
        <label>To</label>
        <input
          type="datetime-local"
          value={to ? toLocalInput(to) : ""}
          onChange={(e) => onToChange(toIso(e.target.value))}
        />
      </div>
    </>
  );
}

/** Convert a datetime-local input value to ISO 8601 string */
function toIso(localValue: string): string {
  if (!localValue) return "";
  return new Date(localValue).toISOString();
}

/** Convert an ISO string to datetime-local input value (YYYY-MM-DDTHH:mm) */
function toLocalInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
