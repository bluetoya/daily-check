import { invoke } from "@tauri-apps/api/core";
import {
  cancel,
  isPermissionGranted,
  pending,
  requestPermission,
  Schedule,
  sendNotification,
  type PermissionState,
} from "@tauri-apps/plugin-notification";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

type Frequency = "Daily" | "Weekdays" | "Weekends" | "CustomDays";
type TabId = "today" | "weekly" | "stats" | "pomodoro" | "routines" | "settings";
type TimerPhase = "focus" | "break";
type NotificationPermissionStatus = PermissionState | "default" | "checking" | "unavailable";

type Routine = {
  id: string;
  title: string;
  frequency: Frequency;
  weekdayMask: string;
  reminder: string;
  focusMinutes: number;
  breakMinutes: number;
  accent: string;
  completedDates: string[];
};

type AppSnapshot = {
  hasSyncKey: boolean;
  soundEnabled: boolean;
  outboxCount: number;
  syncServerUrl: string;
  lastSyncAt?: string | null;
  routines: Routine[];
};

type UnlockResponse = {
  unlocked: boolean;
  syncKey?: string | null;
  message: string;
  snapshot?: AppSnapshot | null;
};

type SyncKeyResponse = {
  syncKey: string;
  message: string;
};

type SyncActionResponse = {
  snapshot: AppSnapshot;
  message: string;
  pushedCount: number;
  pulledCount: number;
  conflictCount: number;
};

type RoutineDraft = {
  title: string;
  frequency: Frequency;
  weekdayMask: string;
  reminder: string;
  accent: string;
};

type TimerDraft = {
  focusMinutes: number;
  breakMinutes: number;
};

type ReminderSpec = {
  id: number;
  title: string;
  body: string;
  schedule: Schedule;
};

type CompletionSummary = {
  scheduled: number;
  completed: number;
  percent: number;
};

type RoutineStat = {
  routine: Routine;
  weekly: CompletionSummary;
  monthly: CompletionSummary;
  streak: number;
};

type SyncStatusTone = "idle" | "syncing" | "success" | "warning" | "error";

type SyncStatus = {
  tone: SyncStatusTone;
  message: string;
  pushedCount: number;
  pulledCount: number;
  conflictCount: number;
};

const weekdayLabels = ["일", "월", "화", "수", "목", "금", "토"];
const ROUTINE_REMINDER_ID_BASE = 300_000_000;
const ROUTINE_REMINDER_ID_RANGE = 200_000_000;
const POMODORO_NOTIFICATION_ID_BASE = 700_000_000;
const TEST_NOTIFICATION_ID = 700_000_100;
const tabs: Array<{ id: TabId; label: string }> = [
  { id: "today", label: "오늘" },
  { id: "weekly", label: "주간 체크" },
  { id: "stats", label: "통계" },
  { id: "pomodoro", label: "뽀모도로" },
  { id: "routines", label: "루틴" },
  { id: "settings", label: "설정" },
];
const frequencyOptions: Array<{ value: Frequency; label: string }> = [
  { value: "Daily", label: "매일" },
  { value: "Weekdays", label: "평일만" },
  { value: "Weekends", label: "주말만" },
  { value: "CustomDays", label: "요일 선택" },
];
const colorOptions = [
  { value: "#f97316", label: "주황" },
  { value: "#2dd4bf", label: "민트" },
  { value: "#facc15", label: "노랑" },
  { value: "#38bdf8", label: "하늘" },
  { value: "#fb7185", label: "분홍" },
  { value: "#a78bfa", label: "보라" },
  { value: "#22c55e", label: "초록" },
  { value: "#ef4444", label: "빨강" },
  { value: "#06b6d4", label: "청록" },
  { value: "#f59e0b", label: "호박" },
];

function isNativeRuntime() {
  const runtime = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in runtime || "__TAURI__" in runtime;
}

function toLocalDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildWeekDays(anchor: Date) {
  const normalized = new Date(anchor);
  normalized.setHours(0, 0, 0, 0);
  const mondayOffset = (normalized.getDay() + 6) % 7;
  normalized.setDate(normalized.getDate() - mondayOffset);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(normalized);
    date.setDate(normalized.getDate() + index);

    return {
      key: toLocalDateKey(date),
      label: weekdayLabels[date.getDay()],
      dateLabel: `${`${date.getMonth() + 1}`.padStart(2, "0")}/${`${date.getDate()}`.padStart(2, "0")}`,
      weekdayIndex: date.getDay(),
    };
  });
}

function buildMonthDays(anchor: Date) {
  const current = new Date(anchor);
  current.setHours(12, 0, 0, 0);

  const cursor = new Date(current.getFullYear(), current.getMonth(), 1, 12);
  const days: string[] = [];

  while (cursor <= current) {
    days.push(toLocalDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

function dateFromKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function formatSeconds(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function generateSyncKey() {
  const chunk = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `DC-${chunk()}-${chunk()}-${chunk()}`;
}

function createLocalId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `routine-${Date.now()}`;
}

function maskForFrequency(frequency: Frequency) {
  switch (frequency) {
    case "Daily":
      return "1111111";
    case "Weekdays":
      return "0111110";
    case "Weekends":
      return "1000001";
    case "CustomDays":
      return "0111110";
  }
}

function toggleMaskDay(mask: string, index: number) {
  const next = mask.split("");
  next[index] = next[index] === "1" ? "0" : "1";
  return next.join("");
}

function frequencyText(frequency: Frequency) {
  return frequencyOptions.find((option) => option.value === frequency)?.label ?? "";
}

function reminderText(reminder: string) {
  return reminder ? reminder : "알림 끔";
}

function isNavigatorOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function buildInitialSyncStatus(): SyncStatus {
  return {
    tone: "idle",
    message: "변경사항은 로컬에 먼저 저장되고, 온라인이 되면 자동으로 동기화됩니다.",
    pushedCount: 0,
    pulledCount: 0,
    conflictCount: 0,
  };
}

function syncStatusToneText(tone: SyncStatusTone) {
  switch (tone) {
    case "syncing":
      return "동기화 중";
    case "success":
      return "정상";
    case "warning":
      return "확인 필요";
    case "error":
      return "실패";
    default:
      return "대기";
  }
}

function buildSyncStatusMessage(response: SyncActionResponse) {
  if (response.conflictCount > 0) {
    return `동기화 완료. 서버 변경 ${response.pulledCount}건을 반영했고 충돌 ${response.conflictCount}건은 더 최신인 로컬 값을 유지했습니다.`;
  }

  if (response.pushedCount === 0 && response.pulledCount === 0) {
    return "동기화할 새 변경이 없습니다.";
  }

  const segments: string[] = [];
  if (response.pushedCount > 0) {
    segments.push(`업로드 ${response.pushedCount}건`);
  }
  if (response.pulledCount > 0) {
    segments.push(`반영 ${response.pulledCount}건`);
  }

  return `동기화 완료. ${segments.join(", ")} 처리했습니다.`;
}

function parseReminderTime(reminder: string) {
  const matched = /^(\d{2}):(\d{2})$/.exec(reminder.trim());
  if (!matched) {
    return null;
  }

  return {
    hour: Number(matched[1]),
    minute: Number(matched[2]),
  };
}

function weekdayToNotificationDay(weekdayIndex: number) {
  return weekdayIndex + 1;
}

function hashNotificationSeed(seed: string) {
  let hash = 0;

  for (const character of seed) {
    hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  }

  return hash & 0x7fffffff;
}

function buildManagedReminderId(routineId: string, weekday: number) {
  return ROUTINE_REMINDER_ID_BASE + (hashNotificationSeed(`${routineId}:${weekday}`) % ROUTINE_REMINDER_ID_RANGE);
}

function isManagedReminderId(id: number) {
  return id >= ROUTINE_REMINDER_ID_BASE && id < ROUTINE_REMINDER_ID_BASE + ROUTINE_REMINDER_ID_RANGE;
}

function notificationPermissionText(status: NotificationPermissionStatus) {
  switch (status) {
    case "granted":
      return "권한 허용됨";
    case "denied":
      return "권한 거부됨";
    case "prompt":
      return "권한 요청 전";
    case "prompt-with-rationale":
      return "권한 설명 필요";
    case "default":
      return "권한 요청 전";
    case "checking":
      return "권한 확인 중";
    case "unavailable":
      return "미지원 환경";
    default:
      return "상태 확인 중";
  }
}

function buildRoutineReminderSpecs(routines: Routine[]) {
  const specs: ReminderSpec[] = [];

  for (const routine of routines) {
    if (!routine.reminder) {
      continue;
    }

    const reminder = parseReminderTime(routine.reminder);
    if (!reminder) {
      continue;
    }

    const body = `${routine.title} 루틴을 체크할 시간입니다.`;

    if (routine.frequency === "Daily") {
      specs.push({
        id: buildManagedReminderId(routine.id, 0),
        title: "Daily Check 리마인더",
        body,
        schedule: Schedule.interval({
          hour: reminder.hour,
          minute: reminder.minute,
          second: 0,
        }),
      });
      continue;
    }

    const weekMask =
      routine.frequency === "CustomDays" ? routine.weekdayMask : maskForFrequency(routine.frequency);

    weekMask.split("").forEach((enabled, index) => {
      if (enabled !== "1") {
        return;
      }

      specs.push({
        id: buildManagedReminderId(routine.id, index + 1),
        title: "Daily Check 리마인더",
        body,
        schedule: Schedule.interval({
          weekday: weekdayToNotificationDay(index),
          hour: reminder.hour,
          minute: reminder.minute,
          second: 0,
        }),
      });
    });
  }

  return specs;
}

function completionPercent(completed: number, scheduled: number) {
  if (scheduled === 0) {
    return 0;
  }

  return Math.round((completed / scheduled) * 100);
}

function summarizeRoutine(routine: Routine, dateKeys: string[]): CompletionSummary {
  let scheduled = 0;
  let completed = 0;

  for (const dateKey of dateKeys) {
    if (!isScheduledOnWeekday(routine, dateFromKey(dateKey).getDay())) {
      continue;
    }

    scheduled += 1;
    if (routine.completedDates.includes(dateKey)) {
      completed += 1;
    }
  }

  return {
    scheduled,
    completed,
    percent: completionPercent(completed, scheduled),
  };
}

function summarizeAllRoutines(routines: Routine[], dateKeys: string[]): CompletionSummary {
  let scheduled = 0;
  let completed = 0;

  for (const routine of routines) {
    const summary = summarizeRoutine(routine, dateKeys);
    scheduled += summary.scheduled;
    completed += summary.completed;
  }

  return {
    scheduled,
    completed,
    percent: completionPercent(completed, scheduled),
  };
}

function computeRoutineStreak(routine: Routine, anchor: Date) {
  const cursor = new Date(anchor);
  cursor.setHours(12, 0, 0, 0);

  let streak = 0;
  for (let offset = 0; offset < 365; offset += 1) {
    const weekday = cursor.getDay();
    if (isScheduledOnWeekday(routine, weekday)) {
      const dateKey = toLocalDateKey(cursor);
      if (routine.completedDates.includes(dateKey)) {
        streak += 1;
      } else {
        break;
      }
    }

    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}

function buildEmptyDraft(): RoutineDraft {
  return {
    title: "",
    frequency: "Daily",
    weekdayMask: maskForFrequency("Daily"),
    reminder: "09:00",
    accent: colorOptions[0].value,
  };
}

function buildDraftFromRoutine(routine: Routine): RoutineDraft {
  return {
    title: routine.title,
    frequency: routine.frequency,
    weekdayMask: routine.weekdayMask,
    reminder: routine.reminder,
    accent: routine.accent,
  };
}

function isScheduledOnWeekday(routine: Routine, weekdayIndex: number) {
  if (routine.frequency === "CustomDays") {
    return routine.weekdayMask[weekdayIndex] === "1";
  }

  return maskForFrequency(routine.frequency)[weekdayIndex] === "1";
}

function buildFallbackSnapshot(anchorDate: Date): AppSnapshot {
  const weekDays = buildWeekDays(anchorDate);

  return {
    hasSyncKey: false,
    soundEnabled: false,
    outboxCount: 0,
    syncServerUrl: "http://localhost:8787",
    lastSyncAt: null,
    routines: [
      {
        id: "planning",
        title: "아침 계획",
        frequency: "Weekdays",
        weekdayMask: "0111110",
        reminder: "09:10",
        focusMinutes: 50,
        breakMinutes: 10,
        accent: "#f97316",
        completedDates: [weekDays[0].key, weekDays[1].key, weekDays[3].key, weekDays[4].key],
      },
      {
        id: "stretch",
        title: "스트레칭",
        frequency: "Daily",
        weekdayMask: "1111111",
        reminder: "14:00",
        focusMinutes: 50,
        breakMinutes: 10,
        accent: "#2dd4bf",
        completedDates: weekDays.slice(0, 5).map((day) => day.key),
      },
      {
        id: "inbox",
        title: "받은 편지함 정리",
        frequency: "CustomDays",
        weekdayMask: "0101010",
        reminder: "17:30",
        focusMinutes: 50,
        breakMinutes: 10,
        accent: "#facc15",
        completedDates: [weekDays[0].key, weekDays[2].key],
      },
      {
        id: "weekend",
        title: "주말 회고",
        frequency: "Weekends",
        weekdayMask: "1000001",
        reminder: "18:20",
        focusMinutes: 50,
        breakMinutes: 10,
        accent: "#38bdf8",
        completedDates: [weekDays[5].key],
      },
    ],
  };
}

function TabIcon({ tab, active }: { tab: TabId; active: boolean }) {
  const stroke = active ? "#17140f" : "#92a099";
  const common = {
    fill: "none",
    stroke,
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (tab) {
    case "today":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M4 10.5L12 4l8 6.5V20H4z" />
          <path {...common} d="M9.5 20v-5h5v5" />
        </svg>
      );
    case "weekly":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect {...common} x="4" y="5" width="16" height="15" rx="3" />
          <path {...common} d="M4 10h16M9.3 5v15M14.7 5v15" />
        </svg>
      );
    case "stats":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M6 18V11M12 18V7M18 18v-4" />
          <path {...common} d="M4 18h16" />
        </svg>
      );
    case "pomodoro":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M9 4h6M8 7h8" />
          <path {...common} d="M12 7c4 0 6.5 2.7 6.5 6.4S16 20 12 20s-6.5-2.9-6.5-6.6S8 7 12 7z" />
          <path {...common} d="M12 10.2v3.3l2.2 1.5" />
        </svg>
      );
    case "routines":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M8 7h11M8 12h11M8 17h11" />
          <path {...common} d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            {...common}
            d="M12 4.8l1.7.5.9 1.7 1.9.4 1.4 1.4-.4 1.9 1 1.5-1 1.5.4 1.9-1.4 1.4-1.9.4-.9 1.7-1.7.5-1.7-.5-.9-1.7-1.9-.4-1.4-1.4.4-1.9-1-1.5 1-1.5-.4-1.9 1.4-1.4 1.9-.4.9-1.7z"
          />
          <circle {...common} cx="12" cy="12" r="3.1" />
        </svg>
      );
    default:
      return null;
  }
}

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(() => buildFallbackSnapshot(new Date()));
  const [runtimeMode, setRuntimeMode] = useState<"native" | "demo">("demo");
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [syncKey, setSyncKey] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [loginMessage, setLoginMessage] = useState("로컬 저장소를 준비하고 있습니다.");
  const [actionMessage, setActionMessage] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("today");
  const [activeRoutineId, setActiveRoutineId] = useState<string | null>(null);
  const [editorRoutineId, setEditorRoutineId] = useState<string | null>(null);
  const [isCreatingRoutine, setIsCreatingRoutine] = useState(false);
  const [draft, setDraft] = useState<RoutineDraft>(() => buildEmptyDraft());
  const [serverUrlDraft, setServerUrlDraft] = useState("http://localhost:8787");
  const [timerDraft, setTimerDraft] = useState<TimerDraft>({
    focusMinutes: 50,
    breakMinutes: 10,
  });
  const [timerPhase, setTimerPhase] = useState<TimerPhase>("focus");
  const [remainingSeconds, setRemainingSeconds] = useState(50 * 60);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermissionStatus>("checking");
  const [isOnline, setIsOnline] = useState(() => isNavigatorOnline());
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => buildInitialSyncStatus());
  const syncInFlightRef = useRef(false);

  const weekDays = useMemo(() => buildWeekDays(now), [now]);
  const monthDays = useMemo(() => buildMonthDays(now), [now]);
  const todayKey = useMemo(() => toLocalDateKey(now), [now]);
  const routines = snapshot.routines;
  const activeRoutine = routines.find((routine) => routine.id === activeRoutineId) ?? routines[0] ?? null;
  const editorRoutine = routines.find((routine) => routine.id === editorRoutineId) ?? null;
  const currentTabLabel = tabs.find((tab) => tab.id === activeTab)?.label ?? "오늘";
  const weekKeys = useMemo(() => weekDays.map((day) => day.key), [weekDays]);
  const todayRoutines = useMemo(
    () => routines.filter((routine) => isScheduledOnWeekday(routine, now.getDay())),
    [routines, now],
  );
  const reminderSignature = useMemo(
    () =>
      routines
        .map((routine) =>
          [routine.id, routine.title, routine.frequency, routine.weekdayMask, routine.reminder].join("|"),
        )
        .sort()
        .join("||"),
    [routines],
  );

  const todayCompletion = useMemo(() => {
    if (todayRoutines.length === 0) {
      return 0;
    }

    const completed = todayRoutines.filter((routine) => routine.completedDates.includes(todayKey)).length;
    return Math.round((completed / todayRoutines.length) * 100);
  }, [todayRoutines, todayKey]);
  const weeklySummary = useMemo(() => summarizeAllRoutines(routines, weekKeys), [routines, weekKeys]);
  const monthlySummary = useMemo(() => summarizeAllRoutines(routines, monthDays), [routines, monthDays]);
  const routineStats = useMemo(() => {
    return routines
      .map((routine) => ({
        routine,
        weekly: summarizeRoutine(routine, weekKeys),
        monthly: summarizeRoutine(routine, monthDays),
        streak: computeRoutineStreak(routine, now),
      }))
      .sort((left, right) => {
        if (right.monthly.percent !== left.monthly.percent) {
          return right.monthly.percent - left.monthly.percent;
        }

        if (right.streak !== left.streak) {
          return right.streak - left.streak;
        }

        return left.routine.title.localeCompare(right.routine.title, "ko");
      });
  }, [routines, weekKeys, monthDays, now]);
  const bestRoutineStat = useMemo(
    () => routineStats.find((stat) => stat.monthly.scheduled > 0) ?? null,
    [routineStats],
  );
  const attentionRoutineStat = useMemo(() => {
    return [...routineStats]
      .reverse()
      .find((stat) => stat.monthly.scheduled > 0) ?? null;
  }, [routineStats]);
  const topStreak = useMemo(
    () => routineStats.reduce((max, stat) => Math.max(max, stat.streak), 0),
    [routineStats],
  );

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(isNavigatorOnline());
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        if (!isNativeRuntime()) {
          throw new Error("Tauri runtime not available");
        }

        const next = await invoke<AppSnapshot>("bootstrap_app");
        if (cancelled) {
          return;
        }

        setRuntimeMode("native");
        setSnapshot(next);
        setLoginMessage(
          next.hasSyncKey
            ? "저장된 동기화 키를 입력하세요."
            : "처음 입력한 값이 이 기기의 동기화 키로 저장됩니다.",
        );
      } catch {
        if (cancelled) {
          return;
        }

        setRuntimeMode("demo");
        setSnapshot(buildFallbackSnapshot(new Date()));
        setLoginMessage("브라우저 미리보기 모드입니다.");
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false);
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!actionMessage) {
      return;
    }

    const timeout = window.setTimeout(() => setActionMessage(""), 2800);
    return () => window.clearTimeout(timeout);
  }, [actionMessage]);

  useEffect(() => {
    setServerUrlDraft(snapshot.syncServerUrl);
  }, [snapshot.syncServerUrl]);

  useEffect(() => {
    if (!isUnlocked || runtimeMode !== "native") {
      setNotificationPermission(runtimeMode === "native" ? "checking" : "unavailable");
      return;
    }

    void syncNotificationPermission(false);
  }, [isUnlocked, runtimeMode]);

  useEffect(() => {
    if (!routines.length) {
      setActiveRoutineId(null);
      return;
    }

    if (!activeRoutineId || !routines.some((routine) => routine.id === activeRoutineId)) {
      setActiveRoutineId(routines[0].id);
    }
  }, [routines, activeRoutineId]);

  useEffect(() => {
    if (!routines.length) {
      setEditorRoutineId(null);
      setIsCreatingRoutine(true);
      setDraft(buildEmptyDraft());
      return;
    }

    if (isCreatingRoutine) {
      return;
    }

    const nextRoutine = routines.find((routine) => routine.id === editorRoutineId) ?? routines[0];
    setEditorRoutineId(nextRoutine.id);
    setDraft(buildDraftFromRoutine(nextRoutine));
  }, [routines, editorRoutineId, isCreatingRoutine]);

  useEffect(() => {
    if (!activeRoutine) {
      return;
    }

    setTimerDraft({
      focusMinutes: activeRoutine.focusMinutes,
      breakMinutes: activeRoutine.breakMinutes,
    });
  }, [activeRoutine?.id, activeRoutine?.focusMinutes, activeRoutine?.breakMinutes]);

  useEffect(() => {
    const minutes =
      timerPhase === "focus" ? activeRoutine?.focusMinutes ?? 50 : activeRoutine?.breakMinutes ?? 10;

    setRemainingSeconds(minutes * 60);
    setIsTimerRunning(false);
  }, [activeRoutine?.id, activeRoutine?.focusMinutes, activeRoutine?.breakMinutes, timerPhase]);

  useEffect(() => {
    if (!isTimerRunning) {
      return;
    }

    const completedPhase = timerPhase;

    const timer = window.setInterval(() => {
      setRemainingSeconds((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          setIsTimerRunning(false);
          setTimerPhase((phase) => (phase === "focus" ? "break" : "focus"));
          setActionMessage(
            completedPhase === "focus"
              ? "집중 시간이 끝났습니다. 휴식 타이머로 전환했어요."
              : "휴식이 끝났습니다. 다시 집중할 시간입니다.",
          );
          void sendPomodoroNotification(completedPhase);
          return 0;
        }

        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isTimerRunning, timerPhase, activeRoutine?.title, runtimeMode, snapshot.soundEnabled]);

  useEffect(() => {
    if (!isUnlocked || runtimeMode !== "native") {
      return;
    }

    let disposed = false;

    async function syncRoutineReminders() {
      const permission = await syncNotificationPermission(false);
      if (disposed) {
        return;
      }

      const scheduled = await pending();
      if (disposed) {
        return;
      }

      const managedIds = scheduled.filter((entry) => isManagedReminderId(entry.id)).map((entry) => entry.id);
      if (managedIds.length > 0) {
        await cancel(managedIds);
      }

      if (permission !== "granted") {
        return;
      }

      for (const spec of buildRoutineReminderSpecs(routines)) {
        sendNotification({
          ...spec,
          group: "routine-reminders",
          silent: !snapshot.soundEnabled,
        });
      }
    }

    void syncRoutineReminders();

    return () => {
      disposed = true;
    };
  }, [isUnlocked, runtimeMode, reminderSignature, notificationPermission, snapshot.soundEnabled]);

  useEffect(() => {
    if (!isUnlocked || runtimeMode !== "native") {
      return;
    }

    if (isOnline) {
      void runSync("reconnect");
      return;
    }

    setSyncStatus({
      tone: "warning",
      message:
        snapshot.outboxCount > 0
          ? `오프라인 상태입니다. 변경 ${snapshot.outboxCount}개를 로컬에 보관 중입니다.`
          : "오프라인 상태입니다. 연결이 돌아오면 자동으로 동기화합니다.",
      pushedCount: 0,
      pulledCount: 0,
      conflictCount: 0,
    });
  }, [isOnline, isUnlocked, runtimeMode, snapshot.outboxCount, syncKey]);

  useEffect(() => {
    if (!isUnlocked || runtimeMode !== "native" || !isOnline || snapshot.outboxCount === 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void runSync("auto");
    }, 2500);

    return () => window.clearTimeout(timeout);
  }, [snapshot.outboxCount, isUnlocked, runtimeMode, isOnline, syncKey]);

  useEffect(() => {
    if (!isUnlocked || runtimeMode !== "native" || !isOnline) {
      return;
    }

    const interval = window.setInterval(() => {
      void runSync("auto");
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [isUnlocked, runtimeMode, isOnline, syncKey]);

  function applySnapshot(nextSnapshot: AppSnapshot) {
    setSnapshot(nextSnapshot);
  }

  function applyLocalSnapshot(mutator: (current: AppSnapshot) => AppSnapshot) {
    let nextSnapshot = snapshot;
    setSnapshot((current) => {
      nextSnapshot = mutator(current);
      return nextSnapshot;
    });
    return nextSnapshot;
  }

  async function runSync(mode: "manual" | "auto" | "reconnect" = "manual") {
    if (runtimeMode !== "native") {
      if (mode === "manual") {
        setActionMessage("미리보기 모드에서는 서버 동기화를 실행할 수 없습니다.");
      }
      return;
    }

    if (!syncKey) {
      if (mode === "manual") {
        setActionMessage("동기화 키를 먼저 설정하세요.");
      }
      return;
    }

    if (!isNavigatorOnline()) {
      const message =
        snapshot.outboxCount > 0
          ? `오프라인 상태입니다. 변경 ${snapshot.outboxCount}개를 로컬에 보관 중입니다.`
          : "오프라인 상태입니다. 연결이 돌아오면 자동으로 동기화합니다.";
      setSyncStatus({
        tone: "warning",
        message,
        pushedCount: 0,
        pulledCount: 0,
        conflictCount: 0,
      });
      if (mode === "manual") {
        setActionMessage(message);
      }
      return;
    }

    if (syncInFlightRef.current) {
      return;
    }

    syncInFlightRef.current = true;
    setSyncStatus((current) => ({
      ...current,
      tone: "syncing",
      message: mode === "manual" ? "서버와 동기화 중입니다." : "백그라운드에서 동기화 중입니다.",
    }));

    try {
      const response = await invoke<SyncActionResponse>("sync_now");
      applySnapshot(response.snapshot);

      const nextMessage = buildSyncStatusMessage(response);
      const nextTone: SyncStatusTone = response.conflictCount > 0 ? "warning" : "success";
      setSyncStatus({
        tone: nextTone,
        message: nextMessage,
        pushedCount: response.pushedCount,
        pulledCount: response.pulledCount,
        conflictCount: response.conflictCount,
      });

      if (mode === "manual" || response.conflictCount > 0) {
        setActionMessage(nextMessage);
      }
    } catch (error) {
      const nextMessage = `동기화에 실패했습니다. ${String(error)}`;
      setSyncStatus({
        tone: "error",
        message: nextMessage,
        pushedCount: 0,
        pulledCount: 0,
        conflictCount: 0,
      });
      if (mode === "manual") {
        setActionMessage(nextMessage);
      }
    } finally {
      syncInFlightRef.current = false;
    }
  }

  async function syncNotificationPermission(interactive: boolean) {
    if (runtimeMode !== "native") {
      setNotificationPermission("unavailable");
      return "unavailable" as const;
    }

    try {
      const browserPermission =
        typeof window.Notification !== "undefined" ? window.Notification.permission : "default";

      if (browserPermission !== "default") {
        setNotificationPermission(browserPermission);
        return browserPermission;
      }

      const granted = await isPermissionGranted();
      if (granted) {
        setNotificationPermission("granted");
        return "granted" as const;
      }

      if (!interactive) {
        setNotificationPermission("default");
        return "default" as const;
      }

      const permission = await requestPermission();
      setNotificationPermission(permission);
      return permission;
    } catch {
      setNotificationPermission("denied");
      return "denied" as const;
    }
  }

  async function sendPomodoroNotification(completedPhase: TimerPhase) {
    if (runtimeMode !== "native") {
      return;
    }

    const permission = await syncNotificationPermission(false);
    if (permission !== "granted") {
      return;
    }

    const title = completedPhase === "focus" ? "집중 시간이 끝났습니다." : "휴식이 끝났습니다.";
    const body =
      completedPhase === "focus"
        ? `${activeRoutine?.title ?? "선택한 루틴"} 휴식으로 전환할 시간입니다.`
        : `${activeRoutine?.title ?? "선택한 루틴"} 다시 집중을 시작할 시간입니다.`;

    sendNotification({
      id: POMODORO_NOTIFICATION_ID_BASE + (completedPhase === "focus" ? 1 : 2),
      title,
      body,
      group: "pomodoro",
      silent: !snapshot.soundEnabled,
    });
  }

  async function handleUnlock() {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setLoginMessage("동기화 키를 입력하세요.");
      return;
    }

    if (runtimeMode === "native") {
      setIsWorking(true);
      try {
        const response = await invoke<UnlockResponse>("unlock_app", { input: trimmed });
        setLoginMessage(response.message);
        if (response.unlocked) {
          setSyncKey(response.syncKey ?? null);
          if (response.snapshot) {
            applySnapshot(response.snapshot);
          }
          setSyncStatus({
            tone: response.message.includes("오프라인") ? "warning" : "success",
            message: response.message,
            pushedCount: 0,
            pulledCount: 0,
            conflictCount: 0,
          });
          setIsUnlocked(true);
        }
      } catch (error) {
        setLoginMessage(String(error));
      } finally {
        setIsWorking(false);
      }
      return;
    }

    if (!syncKey) {
      setSyncKey(trimmed);
      setIsUnlocked(true);
      setLoginMessage("미리보기 키를 저장했습니다.");
      return;
    }

    if (trimmed === syncKey) {
      setIsUnlocked(true);
      setLoginMessage("키가 일치합니다.");
      return;
    }

    setLoginMessage("키가 일치하지 않습니다.");
  }

  async function handleRegenerate() {
    if (runtimeMode === "native") {
      setIsWorking(true);
      try {
        const response = await invoke<SyncKeyResponse>("regenerate_sync_key");
        setSyncKey(response.syncKey);
        setInputValue(response.syncKey);
        setLoginMessage(response.message);
        setSyncStatus({
          tone: "warning",
          message: "동기화 키를 바꿨습니다. 다른 기기에서도 새 키를 다시 입력해야 합니다.",
          pushedCount: 0,
          pulledCount: 0,
          conflictCount: 0,
        });
      } catch (error) {
        setLoginMessage(String(error));
      } finally {
        setIsWorking(false);
      }
      return;
    }

    const nextKey = generateSyncKey();
    setSyncKey(nextKey);
    setInputValue(nextKey);
    setLoginMessage("미리보기 키를 재생성했습니다.");
  }

  async function handleSaveServerUrl() {
    const trimmed = serverUrlDraft.trim();
    if (!trimmed) {
      setActionMessage("동기화 서버 주소를 입력하세요.");
      return;
    }

    if (runtimeMode === "native") {
      setIsWorking(true);
      try {
        const next = await invoke<AppSnapshot>("update_sync_server_url", { input: trimmed });
        applySnapshot(next);
        setSyncStatus({
          tone: "idle",
          message: "새 서버 주소를 저장했습니다. 필요하면 지금 동기화를 눌러 바로 확인할 수 있습니다.",
          pushedCount: 0,
          pulledCount: 0,
          conflictCount: 0,
        });
        setActionMessage("동기화 서버 주소를 저장했습니다.");
      } catch (error) {
        setActionMessage(String(error));
      } finally {
        setIsWorking(false);
      }
      return;
    }

    applyLocalSnapshot((current) => ({
      ...current,
      syncServerUrl: trimmed,
    }));
    setActionMessage("동기화 서버 주소를 저장했습니다.");
  }

  async function handleSyncNow() {
    await runSync("manual");
  }

  async function handleRequestNotificationPermission() {
    const permission = await syncNotificationPermission(true);
    setActionMessage(
      permission === "granted"
        ? "알림 권한을 허용했습니다."
        : "알림 권한이 허용되지 않았습니다. 시스템 설정을 확인해 주세요.",
    );
  }

  async function handleSendTestNotification() {
    if (runtimeMode !== "native") {
      setActionMessage("미리보기 모드에서는 테스트 알림을 보낼 수 없습니다.");
      return;
    }

    const permission = await syncNotificationPermission(true);
    if (permission !== "granted") {
      setActionMessage("알림 권한이 필요합니다.");
      return;
    }

    sendNotification({
      id: TEST_NOTIFICATION_ID,
      title: "Daily Check 테스트 알림",
      body: "루틴 리마인더와 종료 알림이 이 형태로 표시됩니다.",
      group: "test-notifications",
      silent: !snapshot.soundEnabled,
    });
    setActionMessage("테스트 알림을 보냈습니다.");
  }

  async function persistRoutineToggle(routineId: string, date: string) {
    if (runtimeMode === "native") {
      try {
        const next = await invoke<AppSnapshot>("toggle_routine_check", { routineId, date });
        applySnapshot(next);
      } catch (error) {
        setActionMessage(String(error));
      }
      return;
    }

    applyLocalSnapshot((current) => ({
      ...current,
      outboxCount: current.outboxCount + 1,
      routines: current.routines.map((routine) => {
        if (routine.id !== routineId) {
          return routine;
        }

        const hasDate = routine.completedDates.includes(date);
        return {
          ...routine,
          completedDates: hasDate
            ? routine.completedDates.filter((entry) => entry !== date)
            : [...routine.completedDates, date].sort(),
        };
      }),
    }));
  }

  function startCreateRoutine() {
    setActiveTab("routines");
    setIsCreatingRoutine(true);
    setEditorRoutineId(null);
    setDraft(buildEmptyDraft());
  }

  function startEditRoutine(routine: Routine) {
    setActiveTab("routines");
    setIsCreatingRoutine(false);
    setEditorRoutineId(routine.id);
    setDraft(buildDraftFromRoutine(routine));
    setActiveRoutineId(routine.id);
  }

  function updateFrequency(nextFrequency: Frequency) {
    setDraft((current) => ({
      ...current,
      frequency: nextFrequency,
      weekdayMask: nextFrequency === "CustomDays" ? current.weekdayMask : maskForFrequency(nextFrequency),
    }));
  }

  async function handleSaveTimer() {
    if (!activeRoutine) {
      setActionMessage("뽀모도로를 연결할 루틴을 먼저 선택하세요.");
      return;
    }

    if (timerDraft.focusMinutes < 10 || timerDraft.breakMinutes < 5) {
      setActionMessage("집중은 10분 이상, 휴식은 5분 이상이어야 합니다.");
      return;
    }

    setIsWorking(true);
    try {
      if (runtimeMode === "native") {
        const next = await invoke<AppSnapshot>("update_routine_timer", {
          input: {
            id: activeRoutine.id,
            focusMinutes: timerDraft.focusMinutes,
            breakMinutes: timerDraft.breakMinutes,
          },
        });
        applySnapshot(next);
      } else {
        applyLocalSnapshot((current) => ({
          ...current,
          outboxCount: current.outboxCount + 1,
          routines: current.routines.map((routine) =>
            routine.id === activeRoutine.id
              ? {
                  ...routine,
                  focusMinutes: timerDraft.focusMinutes,
                  breakMinutes: timerDraft.breakMinutes,
                }
              : routine,
          ),
        }));
      }

      setActionMessage("뽀모도로 시간을 저장했습니다.");
    } catch (error) {
      setActionMessage(String(error));
    } finally {
      setIsWorking(false);
    }
  }

  async function handleStartTimer() {
    if (!activeRoutine) {
      setActionMessage("뽀모도로를 연결할 루틴을 먼저 선택하세요.");
      return;
    }

    if (runtimeMode === "native" && notificationPermission !== "granted" && notificationPermission !== "denied") {
      const permission = await syncNotificationPermission(true);
      if (permission !== "granted") {
        setActionMessage("알림 권한이 없어 종료 알림 없이 타이머를 시작합니다.");
      }
    }

    setIsTimerRunning(true);
  }

  async function handleSaveRoutine() {
    if (!draft.title.trim()) {
      setActionMessage("루틴 이름을 입력하세요.");
      return;
    }

    if (draft.frequency === "CustomDays" && !draft.weekdayMask.includes("1")) {
      setActionMessage("요일 선택을 쓴다면 최소 하루는 골라야 합니다.");
      return;
    }

    setIsWorking(true);
    try {
      if (runtimeMode === "native") {
        const next = isCreatingRoutine
          ? await invoke<AppSnapshot>("create_routine", { input: draft })
          : await invoke<AppSnapshot>("update_routine", {
              input: {
                id: editorRoutineId,
                ...draft,
              },
            });

        applySnapshot(next);
        const selectedRoutine =
          isCreatingRoutine
            ? next.routines[next.routines.length - 1]
            : next.routines.find((routine) => routine.id === editorRoutineId) ?? next.routines[0];

        if (selectedRoutine) {
          setIsCreatingRoutine(false);
          setEditorRoutineId(selectedRoutine.id);
          setDraft(buildDraftFromRoutine(selectedRoutine));
          setActiveRoutineId(selectedRoutine.id);
        }

        setActionMessage(isCreatingRoutine ? "새 루틴을 저장했습니다." : "루틴을 수정했습니다.");
      } else {
        const next = applyLocalSnapshot((current) => {
          if (isCreatingRoutine) {
            const routine: Routine = {
              id: createLocalId(),
              title: draft.title,
              frequency: draft.frequency,
              weekdayMask: draft.frequency === "CustomDays" ? draft.weekdayMask : maskForFrequency(draft.frequency),
              reminder: draft.reminder,
              focusMinutes: 50,
              breakMinutes: 10,
              accent: draft.accent,
              completedDates: [],
            };

            return {
              ...current,
              outboxCount: current.outboxCount + 1,
              routines: [...current.routines, routine],
            };
          }

          return {
            ...current,
            outboxCount: current.outboxCount + 1,
            routines: current.routines.map((routine) =>
              routine.id === editorRoutineId
                ? {
                    ...routine,
                    title: draft.title,
                    frequency: draft.frequency,
                    weekdayMask:
                      draft.frequency === "CustomDays"
                        ? draft.weekdayMask
                        : maskForFrequency(draft.frequency),
                    reminder: draft.reminder,
                    accent: draft.accent,
                  }
                : routine,
            ),
          };
        });

        const selectedRoutine =
          isCreatingRoutine
            ? next.routines[next.routines.length - 1]
            : next.routines.find((routine) => routine.id === editorRoutineId) ?? next.routines[0];

        if (selectedRoutine) {
          setIsCreatingRoutine(false);
          setEditorRoutineId(selectedRoutine.id);
          setDraft(buildDraftFromRoutine(selectedRoutine));
          setActiveRoutineId(selectedRoutine.id);
        }

        setActionMessage(isCreatingRoutine ? "새 루틴을 저장했습니다." : "루틴을 수정했습니다.");
      }
    } catch (error) {
      setActionMessage(String(error));
    } finally {
      setIsWorking(false);
    }
  }

  async function handleDeleteRoutine() {
    const routineId = editorRoutine?.id ?? editorRoutineId;
    if (!routineId) {
      setActionMessage("삭제할 루틴을 먼저 선택하세요.");
      return;
    }

    setIsWorking(true);
    try {
      if (runtimeMode === "native") {
        const next = await invoke<AppSnapshot>("delete_routine", { routineId });
        if (next.routines.some((routine) => routine.id === routineId)) {
          throw new Error("루틴 삭제가 반영되지 않았습니다.");
        }
        applySnapshot(next);
      } else {
        const next = applyLocalSnapshot((current) => ({
          ...current,
          outboxCount: current.outboxCount + 1,
          routines: current.routines.filter((routine) => routine.id !== routineId),
        }));
        if (next.routines.some((routine) => routine.id === routineId)) {
          throw new Error("루틴 삭제가 반영되지 않았습니다.");
        }
      }

      setIsCreatingRoutine(false);
      setEditorRoutineId(null);
      setDraft(buildEmptyDraft());
      setActionMessage("루틴을 삭제했습니다.");
    } catch (error) {
      setActionMessage(String(error));
    } finally {
      setIsWorking(false);
    }
  }

  function renderTodayScreen() {
    return (
      <div className="screen-stack">
        <section className="summary-strip">
          <article className="mini-card panel">
            <span>오늘 완료율</span>
            <strong>{todayCompletion}%</strong>
          </article>
          <article className="mini-card panel">
            <span>오늘 루틴</span>
            <strong>{todayRoutines.length}개</strong>
          </article>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>오늘 할 루틴</h2>
            <button className="ghost-button small-button" onClick={startCreateRoutine}>
              새 루틴
            </button>
          </div>

          <div className="routine-list">
            {todayRoutines.length === 0 ? (
              <p className="empty-copy">오늘 체크할 루틴이 없습니다.</p>
            ) : (
              todayRoutines.map((routine) => {
                const completed = routine.completedDates.includes(todayKey);
                return (
                  <article className="routine-card" key={routine.id}>
                    <input
                      aria-label={`${routine.title} 완료 상태 토글`}
                      checked={completed}
                      className="check-toggle"
                      onChange={() => persistRoutineToggle(routine.id, todayKey)}
                      style={{ accentColor: routine.accent } as CSSProperties}
                      type="checkbox"
                    />

                    <div className="routine-copy">
                      <strong>{routine.title}</strong>
                      <span>
                        {frequencyText(routine.frequency)} · {reminderText(routine.reminder)}
                      </span>
                    </div>

                    <div className="row-actions">
                      <button className="tiny-button" onClick={() => startEditRoutine(routine)}>
                        편집
                      </button>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>

      </div>
    );
  }

  function renderWeeklyScreen() {
    return (
      <div className="screen-stack">
        <section className="panel block-panel">
          <div className="section-head">
            <h2>주간 체크</h2>
            <span className="tag-pill">
              {weekDays[0].dateLabel} - {weekDays[6].dateLabel}
            </span>
          </div>

          <div className="grid-scroll">
            <div className="weekly-grid">
              <div className="grid-header grid-corner" />
              {weekDays.map((day) => (
                <div className="grid-header" key={day.key}>
                  <span>{day.label}</span>
                  <strong>{day.dateLabel}</strong>
                </div>
              ))}

              {routines.map((routine) => (
                <Fragment key={routine.id}>
                  <button className="grid-label" onClick={() => startEditRoutine(routine)}>
                    <span className="grid-dot" style={{ background: routine.accent }} />
                    <div>
                      <strong>{routine.title}</strong>
                    </div>
                  </button>

                  {weekDays.map((day) => {
                    const checked = routine.completedDates.includes(day.key);
                    const enabled = isScheduledOnWeekday(routine, day.weekdayIndex);
                    return (
                      <button
                        key={`${routine.id}-${day.key}`}
                        className={`grid-cell ${checked ? "grid-cell-active" : ""} ${enabled ? "grid-cell-enabled" : "grid-cell-disabled"}`}
                        disabled={!enabled}
                        onClick={() => persistRoutineToggle(routine.id, day.key)}
                        style={{ "--accent": routine.accent } as CSSProperties}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </section>
      </div>
    );
  }

  function renderPomodoroScreen() {
    const phaseMinutes =
      timerPhase === "focus" ? activeRoutine?.focusMinutes ?? 50 : activeRoutine?.breakMinutes ?? 10;

    return (
      <div className="screen-stack">
        <section className="panel block-panel">
          <div className="section-head">
            <h2>뽀모도로</h2>
            <div className="segmented-group">
              <button
                className={`segment-button ${timerPhase === "focus" ? "segment-button-active" : ""}`}
                onClick={() => setTimerPhase("focus")}
              >
                집중
              </button>
              <button
                className={`segment-button ${timerPhase === "break" ? "segment-button-active" : ""}`}
                onClick={() => setTimerPhase("break")}
              >
                휴식
              </button>
            </div>
          </div>

          {!activeRoutine ? <p className="empty-copy">루틴을 먼저 만든 뒤 사용해 주세요.</p> : null}

          <div className="timer-ring">
            <strong>{formatSeconds(remainingSeconds)}</strong>
            <span>{timerPhase === "focus" ? "집중 시간" : "휴식 시간"}</span>
          </div>

          <div className="button-row">
            <button className="primary-button" onClick={handleStartTimer} disabled={!activeRoutine}>
              시작
            </button>
            <button className="ghost-button" onClick={() => setIsTimerRunning(false)} disabled={!activeRoutine}>
              일시정지
            </button>
            <button
              className="ghost-button"
              onClick={() => setRemainingSeconds(phaseMinutes * 60)}
              disabled={!activeRoutine}
            >
              리셋
            </button>
          </div>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>시간 설정</h2>
          </div>

          <div className="form-grid">
            <label className="mini-field">
              <span>집중 시간</span>
              <input
                type="number"
                min={10}
                step={5}
                disabled={!activeRoutine}
                value={timerDraft.focusMinutes}
                onChange={(event) =>
                  setTimerDraft((current) => ({
                    ...current,
                    focusMinutes: Number(event.target.value) || 0,
                  }))
                }
              />
            </label>

            <label className="mini-field">
              <span>휴식 시간</span>
              <input
                type="number"
                min={5}
                step={5}
                disabled={!activeRoutine}
                value={timerDraft.breakMinutes}
                onChange={(event) =>
                  setTimerDraft((current) => ({
                    ...current,
                    breakMinutes: Number(event.target.value) || 0,
                  }))
                }
              />
            </label>
          </div>

          <div className="button-row">
            <button
              className="ghost-button"
              onClick={() =>
                setTimerDraft({
                  focusMinutes: activeRoutine?.focusMinutes ?? 50,
                  breakMinutes: activeRoutine?.breakMinutes ?? 10,
                })
              }
              disabled={!activeRoutine}
            >
              리셋
            </button>
            <button className="primary-button" onClick={handleSaveTimer} disabled={!activeRoutine || isWorking}>
              저장
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderStatsScreen() {
    return (
      <div className="screen-stack">
        <section className="summary-strip stats-strip">
          <article className="mini-card panel">
            <span>이번 주 완료율</span>
            <strong>{weeklySummary.percent}%</strong>
          </article>
          <article className="mini-card panel">
            <span>이번 달 완료율</span>
            <strong>{monthlySummary.percent}%</strong>
          </article>
          <article className="mini-card panel">
            <span>최고 연속 기록</span>
            <strong>{topStreak}일</strong>
          </article>
        </section>

        <section className="summary-strip">
          <article className="mini-card panel">
            <span>이번 달 가장 잘 지킨 루틴</span>
            <strong>{bestRoutineStat?.routine.title ?? "아직 없음"}</strong>
            <p className="supporting stats-card-copy">
              {bestRoutineStat ? `${bestRoutineStat.monthly.percent}% 완료` : "루틴을 만들면 바로 집계됩니다."}
            </p>
          </article>
          <article className="mini-card panel">
            <span>더 챙기면 좋은 루틴</span>
            <strong>{attentionRoutineStat?.routine.title ?? "아직 없음"}</strong>
            <p className="supporting stats-card-copy">
              {attentionRoutineStat
                ? `${attentionRoutineStat.monthly.percent}% 완료`
                : "루틴을 만들면 바로 집계됩니다."}
            </p>
          </article>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>루틴별 현황</h2>
            <span className="tag-pill">{`${now.getMonth() + 1}월 누적`}</span>
          </div>

          {routineStats.length === 0 ? (
            <p className="empty-copy">통계를 보려면 먼저 루틴을 만들어 주세요.</p>
          ) : (
            <div className="stats-list">
              {routineStats.map((stat) => (
                <article className="routine-stat-card" key={stat.routine.id}>
                  <div className="stat-card-head">
                    <div className="stat-title">
                      <span className="grid-dot" style={{ background: stat.routine.accent }} />
                      <strong>{stat.routine.title}</strong>
                    </div>
                    <span className="tag-pill">{`${stat.streak}일 연속`}</span>
                  </div>

                  <div className="progress-block">
                    <div className="progress-meta">
                      <span>주간</span>
                      <strong>{`${stat.weekly.completed}/${stat.weekly.scheduled || 0}`}</strong>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${stat.weekly.percent}%`, background: stat.routine.accent }} />
                    </div>
                    <span className="supporting">{`${stat.weekly.percent}% 완료`}</span>
                  </div>

                  <div className="progress-block">
                    <div className="progress-meta">
                      <span>월간</span>
                      <strong>{`${stat.monthly.completed}/${stat.monthly.scheduled || 0}`}</strong>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${stat.monthly.percent}%`, background: stat.routine.accent }} />
                    </div>
                    <span className="supporting">{`${stat.monthly.percent}% 완료`}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  function renderRoutinesScreen() {
    return (
      <div className="screen-stack">
        <section className="panel block-panel">
          <div className="section-head">
            <h2>루틴 목록</h2>
            <button className="ghost-button small-button" onClick={startCreateRoutine}>
              새 루틴
            </button>
          </div>

          <div className="chip-scroll">
            {routines.map((routine) => (
              <button
                className={`routine-chip ${editorRoutineId === routine.id && !isCreatingRoutine ? "routine-chip-active" : ""}`}
                key={routine.id}
                onClick={() => startEditRoutine(routine)}
              >
                <span className="routine-chip-dot" style={{ background: routine.accent }} />
                <div>
                  <strong>{routine.title}</strong>
                  <span>{frequencyText(routine.frequency)}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>{isCreatingRoutine ? "새 루틴" : "루틴 수정"}</h2>
            {!isCreatingRoutine && editorRoutineId ? (
              <button className="danger-button small-button" onClick={handleDeleteRoutine} disabled={isWorking}>
                삭제
              </button>
            ) : null}
          </div>

          <div className="form-grid">
            <label className="mini-field">
              <span>이름</span>
              <input
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="루틴 이름"
              />
            </label>

            <label className="mini-field">
              <span>알림 시간</span>
              <div className="time-toggle-row">
                <input
                  type="time"
                  value={draft.reminder}
                  disabled={!draft.reminder}
                  onChange={(event) => setDraft((current) => ({ ...current, reminder: event.target.value }))}
                />
                <button
                  type="button"
                  className={`switch-toggle ${draft.reminder ? "switch-toggle-active" : ""}`}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      reminder: current.reminder ? "" : current.reminder || "09:00",
                    }))
                  }
                >
                  <span className="switch-thumb" />
                </button>
              </div>
            </label>
          </div>

          <div className="selector-block">
            <span className="selector-label">반복 규칙</span>
            <div className="segmented-group">
              {frequencyOptions.map((option) => (
                <button
                  className={`segment-button ${draft.frequency === option.value ? "segment-button-active" : ""}`}
                  key={option.value}
                  onClick={() => updateFrequency(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {draft.frequency === "CustomDays" ? (
            <div className="selector-block">
              <span className="selector-label">요일 선택</span>
              <div className="weekday-group">
                {weekdayLabels.map((label, index) => (
                  <button
                    className={`weekday-button ${draft.weekdayMask[index] === "1" ? "weekday-button-active" : ""}`}
                    key={label}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        weekdayMask: toggleMaskDay(current.weekdayMask, index),
                      }))
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="selector-block">
            <span className="selector-label">컬러</span>
            <div className="color-grid">
              {colorOptions.map((option) => (
                <button
                  className={`color-button ${draft.accent === option.value ? "color-button-active" : ""}`}
                  key={option.value}
                  aria-label={option.label}
                  onClick={() => setDraft((current) => ({ ...current, accent: option.value }))}
                  title={option.label}
                >
                  <span className="color-swatch" style={{ background: option.value }} />
                </button>
              ))}
            </div>
          </div>

          <div className="button-row">
            <button
              className="ghost-button"
              onClick={() => (editorRoutine ? startEditRoutine(editorRoutine) : startCreateRoutine())}
            >
              리셋
            </button>
            <button className="primary-button" onClick={handleSaveRoutine} disabled={isWorking}>
              {isCreatingRoutine ? "루틴 생성" : "저장"}
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderSettingsScreen() {
    return (
      <div className="screen-stack">
        <section className="summary-strip stats-strip">
          <article className="mini-card panel">
            <span>대기 중 변경</span>
            <strong>{snapshot.outboxCount}개</strong>
            <p className="supporting stats-card-copy">
              {snapshot.outboxCount > 0 ? "연결되면 자동으로 서버에 보냅니다." : "로컬과 서버가 같은 상태입니다."}
            </p>
          </article>
          <article className="mini-card panel">
            <span>동기화 상태</span>
            <strong>{syncStatusToneText(syncStatus.tone)}</strong>
            <p className="supporting stats-card-copy">{syncStatus.message}</p>
          </article>
          <article className="mini-card panel">
            <span>마지막 동기화</span>
            <strong>{snapshot.lastSyncAt ?? "아직 없음"}</strong>
            <p className="supporting stats-card-copy">{isOnline ? "온라인" : "오프라인"}</p>
          </article>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>동기화 서버</h2>
            <div className="row-actions">
              <button className="ghost-button small-button" onClick={handleSaveServerUrl} disabled={isWorking}>
                주소 저장
              </button>
              <button
                className="primary-button small-button"
                onClick={handleSyncNow}
                disabled={isWorking || syncStatus.tone === "syncing"}
              >
                지금 동기화
              </button>
            </div>
          </div>

          <label className="mini-field">
            <span>서버 주소</span>
            <input
              value={serverUrlDraft}
              onChange={(event) => setServerUrlDraft(event.target.value)}
              placeholder="http://localhost:8787"
            />
          </label>

          <div className="sync-state-card">
            <div className="sync-state-row">
              <span className={`status-pill status-pill-${syncStatus.tone}`}>{syncStatusToneText(syncStatus.tone)}</span>
              <span className="supporting">{isOnline ? "자동 동기화 켜짐" : "오프라인 저장 중"}</span>
            </div>
            <p className="supporting sync-state-copy">{syncStatus.message}</p>

            <div className="sync-stat-row">
              <div>
                <span>업로드</span>
                <strong>{syncStatus.pushedCount}건</strong>
              </div>
              <div>
                <span>반영</span>
                <strong>{syncStatus.pulledCount}건</strong>
              </div>
              <div>
                <span>충돌</span>
                <strong>{syncStatus.conflictCount}건</strong>
              </div>
            </div>
          </div>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>알림</h2>
            <span className="tag-pill">{notificationPermissionText(notificationPermission)}</span>
          </div>

          <p className="supporting">루틴 리마인더와 뽀모도로 종료 알림에 사용합니다.</p>

          <div className="button-row">
            <button
              className="ghost-button"
              onClick={handleRequestNotificationPermission}
              disabled={runtimeMode !== "native"}
            >
              권한 요청
            </button>
            <button className="primary-button" onClick={handleSendTestNotification} disabled={runtimeMode !== "native"}>
              테스트 알림
            </button>
          </div>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>동기화 키</h2>
            <button className="ghost-button small-button" onClick={handleRegenerate} disabled={isWorking}>
              키 재생성
            </button>
          </div>

          <div className="sync-key-card">
            <span>현재 값</span>
            <strong>{syncKey ?? "저장된 동기화 키가 있습니다."}</strong>
          </div>
        </section>
      </div>
    );
  }

  function renderCurrentScreen() {
    switch (activeTab) {
      case "today":
        return renderTodayScreen();
      case "weekly":
        return renderWeeklyScreen();
      case "stats":
        return renderStatsScreen();
      case "pomodoro":
        return renderPomodoroScreen();
      case "routines":
        return renderRoutinesScreen();
      case "settings":
        return renderSettingsScreen();
      default:
        return null;
    }
  }

  if (isBootstrapping) {
    return (
      <main className="shell auth-shell">
        <section className="auth-card panel">
          <h1>Daily Check</h1>
          <p className="supporting">로컬 저장소를 준비하고 있습니다.</p>
        </section>
      </main>
    );
  }

  if (!isUnlocked) {
    return (
      <main className="shell auth-shell">
        <section className="auth-card panel">
          <h1>Daily Check</h1>
          <p className="supporting">동기화 키를 입력해 앱을 시작하세요.</p>

          <label className="field">
            <span>동기화 키</span>
            <input
              autoFocus
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="원하는 값을 입력하세요"
            />
          </label>

          <div className="button-row">
            <button className="primary-button" onClick={handleUnlock} disabled={isWorking}>
              앱 시작
            </button>
            <button className="ghost-button" onClick={handleRegenerate} disabled={isWorking}>
              키 재생성
            </button>
          </div>

          <p className="callout">{loginMessage}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell app-shell-wrap">
      <section className="app-shell panel">
        <header className="app-header">
          <h1>{currentTabLabel}</h1>
        </header>

        {actionMessage ? <div className="toast-banner">{actionMessage}</div> : null}

        <section className="screen-body">{renderCurrentScreen()}</section>

        <nav className="tab-bar" aria-label="주요 메뉴" style={{ "--tab-count": tabs.length } as CSSProperties}>
          {tabs.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                className={`tab-button ${active ? "tab-button-active" : ""}`}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="tab-icon-wrap">
                  <TabIcon tab={tab.id} active={active} />
                </span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </section>
    </main>
  );
}

export default App;
