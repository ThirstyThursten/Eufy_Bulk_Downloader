import type { SimpleDevice } from "../api";

interface Props {
  devices: SimpleDevice[];
  value: string;
  onChange: (deviceId: string) => void;
}

export function DeviceSelector({ devices, value, onChange }: Props) {
  return (
    <div className="field">
      <label>Camera</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">-- Select a camera --</option>
        {devices.map((d) => (
          <option key={d.serialNumber} value={d.serialNumber}>
            {d.name} ({d.model})
          </option>
        ))}
      </select>
    </div>
  );
}
