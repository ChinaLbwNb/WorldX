import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

export function useLocalGenerationProgress() {
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const timerRef = useRef<number | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const appendLog = useCallback((line: string) => {
    setLogs((prev) => [...prev, line].slice(-12));
  }, []);

  const start = useCallback((line: string) => {
    stopTimer();
    setActive(true);
    setProgress(8);
    setLogs([line]);
    timerRef.current = window.setInterval(() => {
      setProgress((value) => Math.min(88, value + (value < 40 ? 6 : 3)));
    }, 700);
  }, [stopTimer]);

  const mark = useCallback((value: number, line: string) => {
    setActive(true);
    setProgress((prev) => Math.max(prev, Math.min(96, value)));
    appendLog(line);
  }, [appendLog]);

  const finish = useCallback((line: string) => {
    stopTimer();
    setActive(true);
    setProgress(100);
    appendLog(line);
  }, [appendLog, stopTimer]);

  const fail = useCallback((line: string) => {
    stopTimer();
    setActive(true);
    setProgress(100);
    appendLog(line);
  }, [appendLog, stopTimer]);

  const clear = useCallback(() => {
    stopTimer();
    setActive(false);
    setProgress(0);
    setLogs([]);
  }, [stopTimer]);

  useEffect(() => () => stopTimer(), [stopTimer]);

  return { active, progress, logs, start, mark, finish, fail, clear };
}

export function GenerationProgress({
  title,
  progress,
  logs,
}: {
  title: string;
  progress: number;
  logs: string[];
}) {
  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span>{title}</span>
        <span>{Math.round(progress)}%</span>
      </div>
      <div style={trackStyle}>
        <div style={{ ...fillStyle, width: `${Math.max(0, Math.min(100, progress))}%` }} />
      </div>
      {logs.length > 0 && (
        <div style={logBoxStyle}>
          {logs.map((line, index) => (
            <div key={`${line}-${index}`} style={logLineStyle}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const containerStyle: CSSProperties = {
  margin: "10px 12px 0",
  padding: 10,
  borderRadius: 10,
  border: "1px solid rgba(125,212,255,0.18)",
  background: "rgba(5, 10, 20, 0.32)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  color: "rgba(238,244,255,0.78)",
  fontSize: 12,
  fontWeight: 700,
};

const trackStyle: CSSProperties = {
  height: 7,
  marginTop: 7,
  borderRadius: 999,
  overflow: "hidden",
  background: "rgba(255,255,255,0.08)",
};

const fillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: "linear-gradient(90deg, #58acff, #7dd4ff)",
  transition: "width 0.28s ease",
};

const logBoxStyle: CSSProperties = {
  marginTop: 8,
  maxHeight: 92,
  overflowY: "auto",
  display: "grid",
  gap: 4,
};

const logLineStyle: CSSProperties = {
  color: "rgba(238,244,255,0.62)",
  fontSize: 11,
  lineHeight: 1.35,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
