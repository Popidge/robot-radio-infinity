import type { StationState } from "@robot-radio/eleven-shared";

interface RobotDjProps { state: StationState }

function robotMode(state: StationState): "idle" | "thinking" | "listening" | "speaking" | "live" {
  if (!state.running) return "idle";
  if (state.dj.speaking) return "speaking";
  if (state.pendingUser && !state.pendingUser.applied) return "listening";
  if (state.startup?.status === "planning" || state.nextTrack.status === "planning") return "thinking";
  return "live";
}

export function RobotDj({ state }: RobotDjProps) {
  const mode = robotMode(state);
  return (
    <div className={`dj-avatar-panel is-${mode}`} aria-label={`DJ is ${mode}`}>
      <svg viewBox="0 0 260 220" role="img" aria-hidden="true">
        <defs>
          <pattern id="comic-dots" width="10" height="10" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.8" fill="currentColor" />
          </pattern>
        </defs>
        <path className="dj-dots" d="M0 96h84v124H0z" />
        <path className="dj-aerial" d="M119 45V15" />
        <circle className="dj-aerial-tip" cx="119" cy="12" r="9" />
        <path className="dj-headphones" d="M62 112C62 48 188 48 188 112" />
        <path className="dj-ear dj-ear-left" d="M48 98h28v68H48z" />
        <path className="dj-ear dj-ear-right" d="M174 98h28v68h-28z" />
        <path className="dj-head" d="M76 58h98l20 31v92l-24 24H83l-25-25V91z" />
        <path className="dj-face" d="M82 86h84v67H82z" />
        <rect className="dj-eye" x="96" y="105" width="17" height="24" />
        <rect className="dj-eye" x="136" y="105" width="17" height="24" />
        <path className="dj-mouth" d="M102 170h47" />
        <path className="dj-neck" d="M104 204h42v16h-42z" />
        <g className="dj-sound-rays">
          <path d="M208 119l34-13" />
          <path d="M211 139h42" />
          <path d="M208 158l34 14" />
        </g>
        <g className="dj-thought-marks">
          <rect x="207" y="80" width="13" height="13" />
          <rect x="229" y="61" width="10" height="10" />
          <rect x="246" y="46" width="7" height="7" />
        </g>
      </svg>
    </div>
  );
}
