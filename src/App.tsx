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
type RoutineType = "check" | "progress";
type TabId = "today" | "weekly" | "stats" | "pomodoro" | "routines" | "settings";
type TimerPhase = "focus" | "break";
type NotificationPermissionStatus = PermissionState | "default" | "checking" | "unavailable";
type ReminderMeridiem = "AM" | "PM";
type PlanetVariant = "gas" | "storm" | "crater" | "ice" | "dune";

type ProgressEntry = {
  date: string;
  value: number;
};

type Routine = {
  id: string;
  title: string;
  type: RoutineType;
  frequency: Frequency;
  weekdayMask: string;
  reminder: string;
  focusMinutes: number;
  breakMinutes: number;
  accent: string;
  targetValue?: number | null;
  unit?: string | null;
  stepValue?: number | null;
  quickAdjustValues: number[];
  completedDates: string[];
  progressEntries: ProgressEntry[];
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
  type: RoutineType;
  frequency: Frequency;
  weekdayMask: string;
  reminder: string;
  accent: string;
  targetValue: string;
  unit: string;
  stepValue: string;
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

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ROUTINE_REMINDER_ID_BASE = 300_000_000;
const ROUTINE_REMINDER_ID_RANGE = 200_000_000;
const POMODORO_NOTIFICATION_ID_BASE = 700_000_000;
const TEST_NOTIFICATION_ID = 700_000_100;
const tabs: Array<{ id: TabId; label: string }> = [
  { id: "today", label: "Bridge" },
  { id: "weekly", label: "Orbit Grid" },
  { id: "stats", label: "Telemetry" },
  { id: "pomodoro", label: "Burn Cycle" },
  { id: "routines", label: "Protocols" },
  { id: "settings", label: "Systems" },
];
const frequencyOptions: Array<{ value: Frequency; label: string }> = [
  { value: "Daily", label: "Daily Orbit" },
  { value: "Weekdays", label: "Work Orbit" },
  { value: "Weekends", label: "Weekend Orbit" },
  { value: "CustomDays", label: "Custom Orbit" },
];
const progressUnitOptions = [
  { value: "ml", label: "Milliliters (ml)" },
  { value: "L", label: "Liters (L)" },
  { value: "분", label: "Minutes" },
  { value: "페이지", label: "Pages" },
  { value: "회", label: "Repeats" },
  { value: "걸음", label: "Steps" },
  { value: "개", label: "Count" },
];
const reminderHourOptions = Array.from({ length: 12 }, (_, index) => index + 1);
const reminderMinuteOptions = Array.from({ length: 6 }, (_, index) => index * 10);
const colorOptions = [
  { value: "#f97316", label: "Amber" },
  { value: "#2dd4bf", label: "Mint" },
  { value: "#facc15", label: "Solar" },
  { value: "#38bdf8", label: "Sky" },
  { value: "#fb7185", label: "Rose" },
  { value: "#a78bfa", label: "Violet" },
  { value: "#22c55e", label: "Verdant" },
  { value: "#ef4444", label: "Red Shift" },
  { value: "#06b6d4", label: "Cyan" },
  { value: "#f59e0b", label: "Nova" },
];
const tabDescriptions: Record<TabId, string> = {
  today: "Review today's mission queue and keep every protocol in view.",
  weekly: "Scan the week's orbit board and spot completed passes at a glance.",
  stats: "Read streaks, completion, and long-range mission telemetry.",
  pomodoro: "Manage focus burns and recovery drifts from the flight deck.",
  routines: "Tune protocol cadence, progress targets, and reminder windows.",
  settings: "Check uplink health, alert channels, and system controls.",
};
const planetVariants: PlanetVariant[] = ["gas", "storm", "crater", "ice", "dune"];

function isAccentAvailable(routines: Routine[], accent: string, excludedRoutineId?: string | null) {
  return !routines.some((routine) => routine.id !== excludedRoutineId && routine.accent === accent);
}

function findAvailableAccent(routines: Routine[], excludedRoutineId?: string | null) {
  return colorOptions.find((option) => isAccentAvailable(routines, option.value, excludedRoutineId))?.value ?? null;
}

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

function isProgressRoutine(routine: Routine) {
  return routine.type === "progress";
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
  return reminder ? reminder : "No ping";
}

function getProgressEntryValue(
  routine: Routine,
  date: string,
  progressEntryMap?: ReadonlyMap<string, number>,
) {
  if (!isProgressRoutine(routine)) {
    return 0;
  }

  return progressEntryMap?.get(date) ?? routine.progressEntries.find((entry) => entry.date === date)?.value ?? 0;
}

function getRoutineProgressPercent(routine: Routine, value: number) {
  const targetValue = routine.targetValue ?? 0;
  if (!targetValue) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((value / targetValue) * 100)));
}

function getProgressCellLevel(percent: number) {
  if (percent >= 100) {
    return 3;
  }

  if (percent >= 50) {
    return 2;
  }

  if (percent > 0) {
    return 1;
  }

  return 0;
}

function formatProgressLabel(routine: Routine, value: number) {
  const targetValue = routine.targetValue ?? 0;
  const unit = routine.unit ?? "";
  return `${value} / ${targetValue}${unit ? ` ${unit}` : ""}`;
}

function isNavigatorOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function buildInitialSyncStatus(): SyncStatus {
  return {
    tone: "idle",
    message: "Local logs stay primary. The uplink resumes automatically when the channel returns.",
    pushedCount: 0,
    pulledCount: 0,
    conflictCount: 0,
  };
}

function syncStatusToneText(tone: SyncStatusTone) {
  switch (tone) {
    case "syncing":
      return "Uplink Live";
    case "success":
      return "Nominal";
    case "warning":
      return "Check Signal";
    case "error":
      return "Link Lost";
    default:
      return "Standby";
  }
}

function buildSyncStatusMessage(response: SyncActionResponse) {
  if (response.conflictCount > 0) {
    return `Uplink complete. Applied ${response.pulledCount} remote updates and kept ${response.conflictCount} newer local decisions.`;
  }

  if (response.pushedCount === 0 && response.pulledCount === 0) {
    return "No fresh telemetry to sync.";
  }

  const segments: string[] = [];
  if (response.pushedCount > 0) {
    segments.push(`업로드 ${response.pushedCount}건`);
  }
  if (response.pulledCount > 0) {
    segments.push(`반영 ${response.pulledCount}건`);
  }

  return `Uplink complete. ${segments.join(", ")} processed.`;
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

function toReminderControl(reminder: string) {
  const parsed = parseReminderTime(reminder || "00:00") ?? { hour: 0, minute: 0 };
  const meridiem: ReminderMeridiem = parsed.hour >= 12 ? "PM" : "AM";
  const hour12 = parsed.hour % 12 === 0 ? 12 : parsed.hour % 12;

  return {
    hour12,
    minute: parsed.minute,
    meridiem,
  };
}

function toReminderValue(hour12: number, minute: number, meridiem: ReminderMeridiem) {
  const normalizedHour = hour12 % 12 + (meridiem === "PM" ? 12 : 0);

  return `${`${normalizedHour}`.padStart(2, "0")}:${`${minute}`.padStart(2, "0")}`;
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
      return "Channel Open";
    case "denied":
      return "Channel Closed";
    case "prompt":
      return "Awaiting Clearance";
    case "prompt-with-rationale":
      return "Needs Briefing";
    case "default":
      return "Awaiting Clearance";
    case "checking":
      return "Scanning Channel";
    case "unavailable":
      return "Unavailable";
    default:
      return "Checking";
  }
}

function planetVariantForSeed(seed: string): PlanetVariant {
  return planetVariants[hashNotificationSeed(seed) % planetVariants.length] ?? "gas";
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

    const body = `Time to log ${routine.title} in the mission queue.`;

    if (routine.frequency === "Daily") {
      specs.push({
        id: buildManagedReminderId(routine.id, 0),
        title: "Daily Check reminder",
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
        title: "Daily Check reminder",
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

function summarizeRoutine(
  routine: Routine,
  dateKeys: string[],
  completedDates: ReadonlySet<string> = new Set(routine.completedDates),
): CompletionSummary {
  let scheduled = 0;
  let completed = 0;

  for (const dateKey of dateKeys) {
    if (!isScheduledOnWeekday(routine, dateFromKey(dateKey).getDay())) {
      continue;
    }

    scheduled += 1;
    if (completedDates.has(dateKey)) {
      completed += 1;
    }
  }

  return {
    scheduled,
    completed,
    percent: completionPercent(completed, scheduled),
  };
}

function summarizeAllRoutines(
  routines: Routine[],
  dateKeys: string[],
  completedDateSets?: ReadonlyMap<string, ReadonlySet<string>>,
): CompletionSummary {
  let scheduled = 0;
  let completed = 0;

  for (const routine of routines) {
    const summary = summarizeRoutine(routine, dateKeys, completedDateSets?.get(routine.id));
    scheduled += summary.scheduled;
    completed += summary.completed;
  }

  return {
    scheduled,
    completed,
    percent: completionPercent(completed, scheduled),
  };
}

function computeRoutineStreak(
  routine: Routine,
  anchor: Date,
  completedDates: ReadonlySet<string> = new Set(routine.completedDates),
) {
  const cursor = new Date(anchor);
  cursor.setHours(12, 0, 0, 0);

  let streak = 0;
  for (let offset = 0; offset < 365; offset += 1) {
    const weekday = cursor.getDay();
    if (isScheduledOnWeekday(routine, weekday)) {
      const dateKey = toLocalDateKey(cursor);
      if (completedDates.has(dateKey)) {
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
    type: "check",
    frequency: "Daily",
    weekdayMask: maskForFrequency("Daily"),
    reminder: "00:00",
    accent: colorOptions[0].value,
    targetValue: "",
    unit: "",
    stepValue: "",
  };
}

function buildDraftFromRoutine(routine: Routine): RoutineDraft {
  return {
    title: routine.title,
    type: routine.type,
    frequency: routine.frequency,
    weekdayMask: routine.weekdayMask,
    reminder: routine.reminder,
    accent: routine.accent,
    targetValue: routine.targetValue ? String(routine.targetValue) : "",
    unit: routine.unit ?? "",
    stepValue: routine.stepValue ? String(routine.stepValue) : "",
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
        title: "Morning Brief",
        type: "check",
        frequency: "Weekdays",
        weekdayMask: "0111110",
        reminder: "09:10",
        focusMinutes: 50,
        breakMinutes: 10,
        accent: "#f97316",
        targetValue: null,
        unit: null,
        stepValue: null,
        quickAdjustValues: [],
        completedDates: [weekDays[0].key, weekDays[1].key, weekDays[3].key, weekDays[4].key],
        progressEntries: [],
      },
      {
        id: "stretch",
        title: "Mobility Drift",
        type: "check",
        frequency: "Daily",
        weekdayMask: "1111111",
        reminder: "14:00",
        focusMinutes: 50,
        breakMinutes: 10,
        accent: "#2dd4bf",
        targetValue: null,
        unit: null,
        stepValue: null,
        quickAdjustValues: [],
        completedDates: weekDays.slice(0, 5).map((day) => day.key),
        progressEntries: [],
      },
      {
        id: "water",
        title: "Hydration Orbit",
        type: "progress",
        frequency: "Daily",
        weekdayMask: "1111111",
        reminder: "11:00",
        focusMinutes: 50,
        breakMinutes: 10,
        accent: "#38bdf8",
        targetValue: 2000,
        unit: "ml",
        stepValue: 250,
        quickAdjustValues: [-250, 250, 500],
        completedDates: [weekDays[0].key, weekDays[3].key],
        progressEntries: [
          { date: weekDays[0].key, value: 2000 },
          { date: weekDays[1].key, value: 1250 },
          { date: weekDays[2].key, value: 750 },
          { date: weekDays[3].key, value: 2000 },
          { date: weekDays[4].key, value: 1500 },
        ],
      },
      {
        id: "weekend",
        title: "Weekend Debrief",
        type: "check",
        frequency: "Weekends",
        weekdayMask: "1000001",
        reminder: "18:20",
        focusMinutes: 50,
        breakMinutes: 10,
        accent: "#a78bfa",
        targetValue: null,
        unit: null,
        stepValue: null,
        quickAdjustValues: [],
        completedDates: [weekDays[5].key],
        progressEntries: [],
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

function PlanetBadge({
  accent,
  size = "label",
  ringed = false,
  intense = false,
  variant = "gas",
}: {
  accent: string;
  size?: "label" | "chip" | "swatch";
  ringed?: boolean;
  intense?: boolean;
  variant?: PlanetVariant;
}) {
  return (
    <span
      className={`planet-badge planet-badge-${size} ${ringed ? "planet-badge-ringed" : ""} ${
        intense ? "planet-badge-intense" : ""
      }`}
      style={{ "--planet": accent } as CSSProperties}
    >
      <span className={`planet-badge-core planet-badge-variant-${variant}`}>
        <span className="planet-badge-surface" />
      </span>
    </span>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(() => buildFallbackSnapshot(new Date()));
  const [runtimeMode, setRuntimeMode] = useState<"native" | "demo">("demo");
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [syncKey, setSyncKey] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [loginMessage, setLoginMessage] = useState("Warming the local archive.");
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
  const [progressDrafts, setProgressDrafts] = useState<Record<string, number>>({});
  const syncInFlightRef = useRef(false);

  const weekDays = useMemo(() => buildWeekDays(now), [now]);
  const monthDays = useMemo(() => buildMonthDays(now), [now]);
  const todayKey = useMemo(() => toLocalDateKey(now), [now]);
  const routines = snapshot.routines;
  const completedDateSets = useMemo(
    () => new Map(routines.map((routine) => [routine.id, new Set(routine.completedDates)])),
    [routines],
  );
  const progressEntryMaps = useMemo(
    () =>
      new Map(
        routines.map((routine) => [
          routine.id,
          new Map(routine.progressEntries.map((entry) => [entry.date, entry.value])),
        ]),
      ),
    [routines],
  );
  const activeRoutine = routines.find((routine) => routine.id === activeRoutineId) ?? routines[0] ?? null;
  const editorRoutine = routines.find((routine) => routine.id === editorRoutineId) ?? null;
  const currentTabLabel = tabs.find((tab) => tab.id === activeTab)?.label ?? "Bridge";
  const currentTabDescription = tabDescriptions[activeTab];
  const reminderControl = useMemo(() => toReminderControl(draft.reminder || "00:00"), [draft.reminder]);
  const missionDateLabel = useMemo(
    () =>
      now.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        weekday: "short",
      }),
    [now],
  );
  const weekKeys = useMemo(() => weekDays.map((day) => day.key), [weekDays]);
  const todayRoutines = useMemo(
    () => routines.filter((routine) => isScheduledOnWeekday(routine, now.getDay())),
    [routines, now],
  );
  const todayCheckRoutines = useMemo(
    () => todayRoutines.filter((routine) => !isProgressRoutine(routine)),
    [todayRoutines],
  );
  const todayProgressRoutines = useMemo(
    () => todayRoutines.filter((routine) => isProgressRoutine(routine)),
    [todayRoutines],
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

    const completed = todayRoutines.filter((routine) => completedDateSets.get(routine.id)?.has(todayKey)).length;
    return Math.round((completed / todayRoutines.length) * 100);
  }, [todayRoutines, todayKey, completedDateSets]);
  const weeklySummary = useMemo(
    () => summarizeAllRoutines(routines, weekKeys, completedDateSets),
    [routines, weekKeys, completedDateSets],
  );
  const monthlySummary = useMemo(
    () => summarizeAllRoutines(routines, monthDays, completedDateSets),
    [routines, monthDays, completedDateSets],
  );
  const routineStats = useMemo(() => {
    return routines
      .map((routine) => ({
        routine,
        weekly: summarizeRoutine(routine, weekKeys, completedDateSets.get(routine.id)),
        monthly: summarizeRoutine(routine, monthDays, completedDateSets.get(routine.id)),
        streak: computeRoutineStreak(routine, now, completedDateSets.get(routine.id)),
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
  }, [routines, weekKeys, monthDays, now, completedDateSets]);
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
    setProgressDrafts({});
  }, [todayKey]);

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
            ? "Enter the stored sync key to reopen this bridge."
            : "The first key you enter becomes this device's uplink key.",
        );
      } catch {
        if (cancelled) {
          return;
        }

        setRuntimeMode("demo");
        setSnapshot(buildFallbackSnapshot(new Date()));
        setLoginMessage("Preview mode active. Running on local bridge only.");
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
              ? "Focus burn complete. Switching to recovery drift."
              : "Recovery drift complete. Time to reignite focus.",
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
          ? `Offline. Holding ${snapshot.outboxCount} local updates until uplink returns.`
          : "Offline. Auto uplink resumes when the signal returns.",
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
    setProgressDrafts({});
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
        setActionMessage("Preview mode cannot open a live uplink.");
      }
      return;
    }

    if (!syncKey) {
      if (mode === "manual") {
        setActionMessage("Set the sync key before opening uplink.");
      }
      return;
    }

    if (!isNavigatorOnline()) {
      const message =
        snapshot.outboxCount > 0
          ? `Offline. Holding ${snapshot.outboxCount} local updates until uplink returns.`
          : "Offline. Auto uplink resumes when the signal returns.";
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
      message: mode === "manual" ? "Opening live uplink." : "Background uplink in progress.",
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
      const nextMessage = `Uplink failed. ${String(error)}`;
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

    const title = completedPhase === "focus" ? "Focus burn complete." : "Recovery drift complete.";
    const body =
      completedPhase === "focus"
        ? `${activeRoutine?.title ?? "Selected protocol"} is ready for recovery drift.`
        : `${activeRoutine?.title ?? "Selected protocol"} is ready to reignite focus.`;

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
      setLoginMessage("Enter a sync key to unlock the bridge.");
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
            tone: /offline|오프라인/i.test(response.message) ? "warning" : "success",
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
      setLoginMessage("Preview uplink key stored.");
      return;
    }

    if (trimmed === syncKey) {
      setIsUnlocked(true);
      setLoginMessage("Bridge unlocked.");
      return;
    }

    setLoginMessage("Sync key mismatch.");
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
          message: "Sync key rotated. Re-enter the new key on every linked device.",
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
    setLoginMessage("Preview uplink key rotated.");
  }

  async function handleSaveServerUrl() {
    const trimmed = serverUrlDraft.trim();
    if (!trimmed) {
      setActionMessage("Enter an uplink endpoint.");
      return;
    }

    if (runtimeMode === "native") {
      setIsWorking(true);
      try {
        const next = await invoke<AppSnapshot>("update_sync_server_url", { input: trimmed });
        applySnapshot(next);
        setSyncStatus({
          tone: "idle",
          message: "Endpoint saved. Run Sync Now whenever you want an immediate uplink check.",
          pushedCount: 0,
          pulledCount: 0,
          conflictCount: 0,
        });
        setActionMessage("Uplink endpoint saved.");
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
    setActionMessage("Uplink endpoint saved.");
  }

  async function handleSyncNow() {
    await runSync("manual");
  }

  async function handleRequestNotificationPermission() {
    const permission = await syncNotificationPermission(true);
    setActionMessage(
      permission === "granted"
        ? "Alert channel cleared."
        : "Alert channel still blocked. Check system settings.",
    );
  }

  async function handleSendTestNotification() {
    if (runtimeMode !== "native") {
      setActionMessage("Preview mode cannot send a live test ping.");
      return;
    }

    const permission = await syncNotificationPermission(true);
    if (permission !== "granted") {
      setActionMessage("Alert channel clearance is required.");
      return;
    }

    sendNotification({
      id: TEST_NOTIFICATION_ID,
      title: "Daily Check test ping",
      body: "Routine pings and burn-cycle alerts will appear in this format.",
      group: "test-notifications",
      silent: !snapshot.soundEnabled,
    });
    setActionMessage("Test ping sent.");
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

  async function persistRoutineProgress(routine: Routine, date: string, value: number) {
    const targetValue = routine.targetValue ?? 0;
    const nextValue = Math.max(0, Math.min(targetValue, Math.round(value)));
    const draftKey = `${routine.id}:${date}`;

    if (runtimeMode === "native") {
      try {
        const next = await invoke<AppSnapshot>("update_routine_progress", {
          input: {
            routineId: routine.id,
            date,
            value: nextValue,
          },
        });
        applySnapshot(next);
      } catch (error) {
        setActionMessage(String(error));
        setProgressDrafts((current) => {
          const nextDrafts = { ...current };
          delete nextDrafts[draftKey];
          return nextDrafts;
        });
      }
      return;
    }

    applyLocalSnapshot((current) => ({
      ...current,
      outboxCount: current.outboxCount + 1,
      routines: current.routines.map((entry) => {
        if (entry.id !== routine.id) {
          return entry;
        }

        const completedDates = new Set(entry.completedDates);
        const nextEntries = entry.progressEntries.filter((progress) => progress.date !== date);

        if (nextValue > 0) {
          nextEntries.push({ date, value: nextValue });
        }

        if (nextValue >= (entry.targetValue ?? 0)) {
          completedDates.add(date);
        } else {
          completedDates.delete(date);
        }

        return {
          ...entry,
          completedDates: [...completedDates].sort(),
          progressEntries: nextEntries.sort((left, right) => left.date.localeCompare(right.date)),
        };
      }),
    }));

    setProgressDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[draftKey];
      return nextDrafts;
    });
  }

  function startCreateRoutine() {
    const nextAccent = findAvailableAccent(routines);
    setActiveTab("routines");
    setIsCreatingRoutine(true);
    setEditorRoutineId(null);
    setDraft({
      ...buildEmptyDraft(),
      accent: nextAccent ?? colorOptions[0].value,
    });
    if (!nextAccent) {
      setActionMessage("No open planet signature left. Reassign an existing one first.");
    }
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

  function updateRoutineType(nextType: RoutineType) {
    setDraft((current) => {
      if (nextType === "progress") {
        return {
          ...current,
          type: nextType,
          targetValue: current.targetValue || "2000",
          unit: current.unit || "ml",
          stepValue: current.stepValue || "250",
        };
      }

      return {
        ...current,
        type: nextType,
        targetValue: "",
        unit: "",
        stepValue: "",
      };
    });
  }

  function updateReminderControl(partial: Partial<{ hour12: number; minute: number; meridiem: ReminderMeridiem }>) {
    const next = {
      ...reminderControl,
      ...partial,
    };

    setDraft((current) => ({
      ...current,
      reminder: toReminderValue(next.hour12, next.minute, next.meridiem),
    }));
  }

  async function handleSaveTimer() {
    if (!activeRoutine) {
      setActionMessage("Select a protocol before linking the burn cycle.");
      return;
    }

    if (timerDraft.focusMinutes < 10 || timerDraft.breakMinutes < 5) {
      setActionMessage("Focus burn must be at least 10 minutes and recovery drift at least 5.");
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

      setActionMessage("Burn-cycle timing saved.");
    } catch (error) {
      setActionMessage(String(error));
    } finally {
      setIsWorking(false);
    }
  }

  async function handleStartTimer() {
    if (!activeRoutine) {
      setActionMessage("Select a protocol before linking the burn cycle.");
      return;
    }

    if (runtimeMode === "native" && notificationPermission !== "granted" && notificationPermission !== "denied") {
      const permission = await syncNotificationPermission(true);
      if (permission !== "granted") {
        setActionMessage("Alert channel is closed. Starting without an end-of-cycle ping.");
      }
    }

    setIsTimerRunning(true);
  }

  async function handleSaveRoutine() {
    if (!draft.title.trim()) {
      setActionMessage("Enter a protocol name.");
      return;
    }

    if (draft.frequency === "CustomDays" && !draft.weekdayMask.includes("1")) {
      setActionMessage("Choose at least one orbit day when using Custom Orbit.");
      return;
    }

    const stepValue = draft.type === "progress" ? Number(draft.stepValue) : null;
    const targetValue = draft.type === "progress" ? Number(draft.targetValue) : null;
    const unit = draft.type === "progress" ? draft.unit.trim() : null;

    if (draft.type === "progress") {
      if (!targetValue || targetValue <= 0) {
        setActionMessage("Progress tracks need a target value.");
        return;
      }

      if (!unit) {
        setActionMessage("Progress tracks need a unit.");
        return;
      }

      if (!stepValue || stepValue <= 0) {
        setActionMessage("Progress tracks need a slider step.");
        return;
      }
    }

    if (!isAccentAvailable(routines, draft.accent, isCreatingRoutine ? null : editorRoutineId)) {
      setActionMessage("That planet signature is already assigned.");
      return;
    }

    const routinePayload = {
      title: draft.title.trim(),
      type: draft.type,
      frequency: draft.frequency,
      weekdayMask: draft.frequency === "CustomDays" ? draft.weekdayMask : maskForFrequency(draft.frequency),
      reminder: draft.reminder,
      accent: draft.accent,
      targetValue: draft.type === "progress" ? targetValue : null,
      unit: draft.type === "progress" ? unit : null,
      stepValue: draft.type === "progress" ? stepValue : null,
      quickAdjustValues: [],
    };

    setIsWorking(true);
    try {
      if (runtimeMode === "native") {
        const next = isCreatingRoutine
          ? await invoke<AppSnapshot>("create_routine", { input: routinePayload })
          : await invoke<AppSnapshot>("update_routine", {
              input: {
                id: editorRoutineId,
                ...routinePayload,
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

        setActionMessage(isCreatingRoutine ? "New protocol created." : "Protocol updated.");
      } else {
        const next = applyLocalSnapshot((current) => {
          if (isCreatingRoutine) {
            const routine: Routine = {
              id: createLocalId(),
              title: routinePayload.title,
              type: routinePayload.type,
              frequency: routinePayload.frequency,
              weekdayMask: routinePayload.weekdayMask,
              reminder: routinePayload.reminder,
              focusMinutes: 50,
              breakMinutes: 10,
              accent: routinePayload.accent,
              targetValue: routinePayload.targetValue,
              unit: routinePayload.unit,
              stepValue: routinePayload.stepValue,
              quickAdjustValues: routinePayload.quickAdjustValues,
              completedDates: [],
              progressEntries: [],
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
                    title: routinePayload.title,
                    type: routinePayload.type,
                    frequency: routinePayload.frequency,
                    weekdayMask: routinePayload.weekdayMask,
                    reminder: routinePayload.reminder,
                    accent: routinePayload.accent,
                    targetValue: routinePayload.targetValue,
                    unit: routinePayload.unit,
                    stepValue: routinePayload.stepValue,
                    quickAdjustValues: routinePayload.quickAdjustValues,
                    completedDates:
                      routinePayload.type === "progress"
                        ? routine.completedDates.filter((date) => {
                            const value =
                              routine.progressEntries.find((entry) => entry.date === date)?.value ?? 0;
                            return value >= (routinePayload.targetValue ?? 0);
                          })
                        : routine.completedDates,
                    progressEntries:
                      routinePayload.type === "progress" ? routine.progressEntries : [],
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

        setActionMessage(isCreatingRoutine ? "New protocol created." : "Protocol updated.");
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
      setActionMessage("Select a protocol to delete.");
      return;
    }

    setIsWorking(true);
    try {
      if (runtimeMode === "native") {
        const next = await invoke<AppSnapshot>("delete_routine", { routineId });
        if (next.routines.some((routine) => routine.id === routineId)) {
          throw new Error("Protocol deletion did not apply.");
        }
        applySnapshot(next);
      } else {
        const next = applyLocalSnapshot((current) => ({
          ...current,
          outboxCount: current.outboxCount + 1,
          routines: current.routines.filter((routine) => routine.id !== routineId),
        }));
        if (next.routines.some((routine) => routine.id === routineId)) {
          throw new Error("Protocol deletion did not apply.");
        }
      }

      setIsCreatingRoutine(false);
      setEditorRoutineId(null);
      setDraft(buildEmptyDraft());
      setActionMessage("Protocol deleted.");
    } catch (error) {
      setActionMessage(String(error));
    } finally {
      setIsWorking(false);
    }
  }

  function renderTodayRoutineCard(routine: Routine) {
    const completed = completedDateSets.get(routine.id)?.has(todayKey) ?? false;
    const draftKey = `${routine.id}:${todayKey}`;
    const sliderValue =
      progressDrafts[draftKey] ?? getProgressEntryValue(routine, todayKey, progressEntryMaps.get(routine.id));
    const progressPercent = getRoutineProgressPercent(routine, sliderValue);

    return (
      <article className={`routine-card ${isProgressRoutine(routine) ? "progress-routine-card" : ""}`} key={routine.id}>
        {isProgressRoutine(routine) ? (
          <>
            <div className="progress-routine-head">
              <div className="routine-copy progress-routine-copy">
                <strong>{routine.title}</strong>
                <span>
                  {frequencyText(routine.frequency)} · {reminderText(routine.reminder)}
                </span>
              </div>

              <button
                className="ghost-button tiny-button progress-edit-button"
                onClick={() => startEditRoutine(routine)}
              >
                편집
              </button>
            </div>

            <div className="progress-routine-meta">
              <strong>{formatProgressLabel(routine, sliderValue)}</strong>
              <span>{progressPercent}% 달성</span>
            </div>

            <input
              aria-label={`${routine.title} 진행률`}
              className="progress-slider"
              type="range"
              min={0}
              max={routine.targetValue ?? 100}
              step={routine.stepValue ?? 1}
              value={sliderValue}
              onChange={(event) =>
                setProgressDrafts((current) => ({
                  ...current,
                  [draftKey]: Number(event.target.value),
                }))
              }
              onPointerUp={(event) =>
                void persistRoutineProgress(routine, todayKey, Number(event.currentTarget.value))
              }
              onKeyUp={(event) =>
                void persistRoutineProgress(routine, todayKey, Number(event.currentTarget.value))
              }
              style={
                {
                  "--accent": routine.accent,
                  "--progress": `${progressPercent}%`,
                } as CSSProperties
              }
            />
          </>
        ) : (
          <>
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
          </>
        )}
      </article>
    );
  }

  function renderTodayRoutineGroup(title: string, routinesForGroup: Routine[]) {
    if (routinesForGroup.length === 0) {
      return null;
    }

    return (
      <section className="routine-group" key={title}>
        <div className="routine-group-head">
          <strong>{title}</strong>
          <span>{routinesForGroup.length}</span>
        </div>
        <div className="routine-list">{routinesForGroup.map((routine) => renderTodayRoutineCard(routine))}</div>
      </section>
    );
  }

  function renderTodayScreen() {
    return (
      <div className="screen-stack">
        <section className="summary-strip">
          <article className="mini-card panel">
            <span>Mission Yield</span>
            <strong>{todayCompletion}%</strong>
          </article>
          <article className="mini-card panel">
            <span>Assigned Protocols</span>
            <strong>{todayRoutines.length}</strong>
          </article>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>Mission Queue</h2>
            <button className="ghost-button small-button" onClick={startCreateRoutine}>
              Add Protocol
            </button>
          </div>

          {todayRoutines.length > 0 ? (
            <div className="today-routine-groups">
              {renderTodayRoutineGroup("Binary Checks", todayCheckRoutines)}
              {renderTodayRoutineGroup("Progress Tracks", todayProgressRoutines)}
            </div>
          ) : null}

          <div className="routine-list">
            {todayRoutines.length === 0 ? (
              <p className="empty-copy">No protocols scheduled for this cycle.</p>
            ) : (
              todayRoutines.map((routine) => {
                const completed = completedDateSets.get(routine.id)?.has(todayKey) ?? false;
                const draftKey = `${routine.id}:${todayKey}`;
                const sliderValue =
                  progressDrafts[draftKey] ??
                  getProgressEntryValue(routine, todayKey, progressEntryMaps.get(routine.id));
                const progressPercent = getRoutineProgressPercent(routine, sliderValue);
                return (
                  <article
                    className={`routine-card ${isProgressRoutine(routine) ? "progress-routine-card" : ""}`}
                    key={routine.id}
                  >
                    {isProgressRoutine(routine) ? (
                      <>
                        <div className="progress-routine-head">
                          <div className="routine-copy progress-routine-copy">
                            <strong>{routine.title}</strong>
                            <span>
                              {frequencyText(routine.frequency)} · {reminderText(routine.reminder)}
                            </span>
                          </div>

                          <button
                            className="ghost-button tiny-button progress-edit-button"
                            onClick={() => startEditRoutine(routine)}
                          >
                            Tune
                          </button>
                        </div>

                        <div className="progress-routine-meta">
                          <strong>{formatProgressLabel(routine, sliderValue)}</strong>
                          <span>{progressPercent}% 달성</span>
                        </div>

                        <input
                          aria-label={`${routine.title} 진행률`}
                          className="progress-slider"
                          type="range"
                          min={0}
                          max={routine.targetValue ?? 100}
                          step={routine.stepValue ?? 1}
                          value={sliderValue}
                          onChange={(event) =>
                            setProgressDrafts((current) => ({
                              ...current,
                              [draftKey]: Number(event.target.value),
                            }))
                          }
                          onPointerUp={(event) =>
                            void persistRoutineProgress(routine, todayKey, Number(event.currentTarget.value))
                          }
                          onKeyUp={(event) =>
                            void persistRoutineProgress(routine, todayKey, Number(event.currentTarget.value))
                          }
                          style={
                            {
                              "--accent": routine.accent,
                              "--progress": `${progressPercent}%`,
                            } as CSSProperties
                          }
                        />

                      </>
                    ) : (
                      <>
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
                            Tune
                          </button>
                        </div>
                      </>
                    )}
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
            <h2>Orbit Grid</h2>
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
                    <PlanetBadge
                      accent={routine.accent}
                      intense={routine.type === "progress"}
                      ringed={routine.type === "progress"}
                      size="label"
                      variant={planetVariantForSeed(`${routine.id}:${routine.type}`)}
                    />
                    <div>
                      <strong>{routine.title}</strong>
                    </div>
                  </button>

                  {weekDays.map((day) => {
                    const checked = completedDateSets.get(routine.id)?.has(day.key) ?? false;
                    const enabled = isScheduledOnWeekday(routine, day.weekdayIndex);
                    const progressValue = getProgressEntryValue(
                      routine,
                      day.key,
                      progressEntryMaps.get(routine.id),
                    );
                    const progressLevel = getProgressCellLevel(
                      getRoutineProgressPercent(routine, progressValue),
                    );

                    if (isProgressRoutine(routine)) {
                      return (
                        <div
                          key={`${routine.id}-${day.key}`}
                          className={`grid-cell ${enabled ? "grid-cell-enabled" : "grid-cell-disabled"} grid-cell-progress-${enabled && progressLevel === 3 ? 3 : 0}`}
                          style={{ "--accent": routine.accent } as CSSProperties}
                        />
                      );
                    }

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
            <h2>Burn Cycle</h2>
            <div className="segmented-group">
              <button
                className={`segment-button ${timerPhase === "focus" ? "segment-button-active" : ""}`}
                onClick={() => setTimerPhase("focus")}
              >
                Focus Burn
              </button>
              <button
                className={`segment-button ${timerPhase === "break" ? "segment-button-active" : ""}`}
                onClick={() => setTimerPhase("break")}
              >
                Recovery Drift
              </button>
            </div>
          </div>

          {!activeRoutine ? <p className="empty-copy">Select a protocol before igniting the timer.</p> : null}

          <div className="timer-ring">
            <strong>{formatSeconds(remainingSeconds)}</strong>
            <span>{timerPhase === "focus" ? "Focus Burn" : "Recovery Drift"}</span>
          </div>

          <div className="button-row">
            <button className="primary-button" onClick={handleStartTimer} disabled={!activeRoutine}>
              Ignite
            </button>
            <button className="ghost-button" onClick={() => setIsTimerRunning(false)} disabled={!activeRoutine}>
              Hold
            </button>
            <button
              className="ghost-button"
              onClick={() => setRemainingSeconds(phaseMinutes * 60)}
              disabled={!activeRoutine}
            >
              Reset
            </button>
          </div>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>Cycle Timing</h2>
          </div>

          <div className="form-grid">
            <label className="mini-field">
              <span>Focus Minutes</span>
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
              <span>Recovery Minutes</span>
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
              Reset
            </button>
            <button className="primary-button" onClick={handleSaveTimer} disabled={!activeRoutine || isWorking}>
              Save
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
            <span>Weekly Yield</span>
            <strong>{weeklySummary.percent}%</strong>
          </article>
          <article className="mini-card panel">
            <span>Monthly Yield</span>
            <strong>{monthlySummary.percent}%</strong>
          </article>
          <article className="mini-card panel">
            <span>Top Streak</span>
            <strong>{topStreak} cycles</strong>
          </article>
        </section>

        <section className="summary-strip">
          <article className="mini-card panel">
            <span>Best Signal</span>
            <strong>{bestRoutineStat?.routine.title ?? "No signal yet"}</strong>
            <p className="supporting stats-card-copy">
              {bestRoutineStat ? `${bestRoutineStat.monthly.percent}% complete` : "Create a protocol to start telemetry."}
            </p>
          </article>
          <article className="mini-card panel">
            <span>Needs Attention</span>
            <strong>{attentionRoutineStat?.routine.title ?? "No signal yet"}</strong>
            <p className="supporting stats-card-copy">
              {attentionRoutineStat
                ? `${attentionRoutineStat.monthly.percent}% complete`
                : "Create a protocol to start telemetry."}
            </p>
          </article>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>Protocol Telemetry</h2>
            <span className="tag-pill">{`${now.getMonth() + 1} Month Log`}</span>
          </div>

          {routineStats.length === 0 ? (
            <p className="empty-copy">Create a protocol to light up telemetry.</p>
          ) : (
            <div className="stats-list">
              {routineStats.map((stat) => (
                <article className="routine-stat-card" key={stat.routine.id}>
                  <div className="stat-card-head">
                    <div className="stat-title">
                      <PlanetBadge
                        accent={stat.routine.accent}
                        intense={stat.routine.type === "progress"}
                        ringed={stat.routine.type === "progress"}
                        size="label"
                        variant={planetVariantForSeed(`${stat.routine.id}:${stat.routine.type}`)}
                      />
                      <strong>{stat.routine.title}</strong>
                    </div>
                    <span className="tag-pill">{`${stat.streak} cycle streak`}</span>
                  </div>

                  <div className="progress-block">
                    <div className="progress-meta">
                      <span>Weekly</span>
                      <strong>{`${stat.weekly.completed}/${stat.weekly.scheduled || 0}`}</strong>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${stat.weekly.percent}%`, background: stat.routine.accent }} />
                    </div>
                    <span className="supporting">{`${stat.weekly.percent}% complete`}</span>
                  </div>

                  <div className="progress-block">
                    <div className="progress-meta">
                      <span>Monthly</span>
                      <strong>{`${stat.monthly.completed}/${stat.monthly.scheduled || 0}`}</strong>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${stat.monthly.percent}%`, background: stat.routine.accent }} />
                    </div>
                    <span className="supporting">{`${stat.monthly.percent}% complete`}</span>
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
            <h2>Protocol Deck</h2>
            <button className="ghost-button small-button" onClick={startCreateRoutine}>
              Add Protocol
            </button>
          </div>

          <div className="chip-scroll">
            {routines.map((routine) => (
              <button
                className={`routine-chip ${editorRoutineId === routine.id && !isCreatingRoutine ? "routine-chip-active" : ""}`}
                key={routine.id}
                onClick={() => startEditRoutine(routine)}
              >
                <PlanetBadge
                  accent={routine.accent}
                  intense={routine.type === "progress"}
                  ringed={routine.type === "progress"}
                  size="chip"
                  variant={planetVariantForSeed(`${routine.id}:${routine.type}`)}
                />
                <div>
                  <strong>{routine.title}</strong>
                  <span>
                    {routine.type === "progress"
                      ? `Progress Track · ${routine.targetValue ?? 0}${routine.unit ? ` ${routine.unit}` : ""}`
                      : frequencyText(routine.frequency)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>{isCreatingRoutine ? "New Protocol" : "Tune Protocol"}</h2>
            <div className="section-head-actions">
              <button
                className="ghost-button small-button"
                onClick={() => (editorRoutine ? startEditRoutine(editorRoutine) : startCreateRoutine())}
              >
                Reset
              </button>
              <button className="primary-button small-button" onClick={handleSaveRoutine} disabled={isWorking}>
                {isCreatingRoutine ? "Create" : "Save"}
              </button>
              {!isCreatingRoutine && editorRoutineId ? (
                <button className="danger-button small-button" onClick={handleDeleteRoutine} disabled={isWorking}>
                  Delete
                </button>
              ) : null}
            </div>
          </div>

          <div className="form-grid">
            <label className="mini-field">
              <span>Protocol Name</span>
              <input
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="Name this protocol"
              />
            </label>

            <label className="mini-field">
              <span>Ping Window</span>
              <div className="time-toggle-row">
                <div className={`time-picker-shell ${draft.reminder ? "" : "time-picker-shell-disabled"}`}>
                  <select
                    aria-label="Reminder hour"
                    className="time-picker-select"
                    value={reminderControl.hour12}
                    disabled={!draft.reminder}
                    onChange={(event) => updateReminderControl({ hour12: Number(event.target.value) })}
                  >
                    {reminderHourOptions.map((hour) => (
                      <option key={hour} value={hour}>
                        {`${hour}`.padStart(2, "0")}
                      </option>
                    ))}
                  </select>
                  <span className="time-picker-divider">:</span>
                  <select
                    aria-label="Reminder minute"
                    className="time-picker-select"
                    value={reminderControl.minute}
                    disabled={!draft.reminder}
                    onChange={(event) => updateReminderControl({ minute: Number(event.target.value) })}
                  >
                    {reminderMinuteOptions.map((minute) => (
                      <option key={minute} value={minute}>
                        {`${minute}`.padStart(2, "0")}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`meridiem-cycle-button ${draft.reminder ? "meridiem-cycle-button-active" : ""}`}
                    disabled={!draft.reminder}
                    onClick={() =>
                      updateReminderControl({
                        meridiem: reminderControl.meridiem === "AM" ? "PM" : "AM",
                      })
                    }
                  >
                    {reminderControl.meridiem}
                  </button>
                </div>
                <button
                  type="button"
                  className={`switch-toggle ${draft.reminder ? "switch-toggle-active" : ""}`}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      reminder: current.reminder ? "" : "00:00",
                    }))
                  }
                >
                  <span className="switch-thumb" />
                </button>
              </div>
            </label>
          </div>

          <div className="selector-block">
            <span className="selector-label">Protocol Type</span>
            <div className="segmented-group">
              <button
                className={`segment-button ${draft.type === "check" ? "segment-button-active" : ""}`}
                onClick={() => updateRoutineType("check")}
              >
                Binary Check
              </button>
              <button
                className={`segment-button ${draft.type === "progress" ? "segment-button-active" : ""}`}
                onClick={() => updateRoutineType("progress")}
              >
                Progress Track
              </button>
            </div>
          </div>

          <div className="selector-block">
            <span className="selector-label">Cycle Pattern</span>
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

          {draft.type === "progress" ? (
            <div className="progress-settings-card">
              <div className="progress-settings-grid">
                <label className="mini-field modern-field">
                  <span>Target</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.targetValue}
                    onChange={(event) => setDraft((current) => ({ ...current, targetValue: event.target.value }))}
                    placeholder="2000"
                  />
                </label>

                <label className="mini-field modern-field">
                  <span>Unit</span>
                  <select
                    value={draft.unit}
                    onChange={(event) => setDraft((current) => ({ ...current, unit: event.target.value }))}
                  >
                    {!draft.unit ? <option value="">Select unit</option> : null}
                    {progressUnitOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="mini-field modern-field">
                  <span>Slider Step</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.stepValue}
                    onChange={(event) => setDraft((current) => ({ ...current, stepValue: event.target.value }))}
                    placeholder="250"
                  />
                </label>
              </div>
            </div>
          ) : null}

          {draft.frequency === "CustomDays" ? (
            <div className="selector-block">
              <span className="selector-label">Orbit Days</span>
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
            <span className="selector-label">Planet Signature</span>
            <div className="color-grid">
              {colorOptions.map((option) => (
                <button
                  className={`color-button ${draft.accent === option.value ? "color-button-active" : ""} ${
                    !isAccentAvailable(routines, option.value, isCreatingRoutine ? null : editorRoutineId) &&
                    draft.accent !== option.value
                      ? "color-button-disabled"
                      : ""
                  }`}
                  key={option.value}
                  aria-label={option.label}
                  disabled={
                    !isAccentAvailable(routines, option.value, isCreatingRoutine ? null : editorRoutineId) &&
                    draft.accent !== option.value
                  }
                  onClick={() => setDraft((current) => ({ ...current, accent: option.value }))}
                  title={
                    !isAccentAvailable(routines, option.value, isCreatingRoutine ? null : editorRoutineId) &&
                    draft.accent !== option.value
                      ? "Already assigned to another protocol"
                      : option.label
                  }
                >
                  <PlanetBadge
                    accent={option.value}
                    intense={draft.type === "progress" || draft.accent === option.value}
                    ringed={draft.accent === option.value}
                    size="swatch"
                    variant={planetVariantForSeed(option.value)}
                  />
                </button>
              ))}
            </div>
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
            <span>Pending Uploads</span>
            <strong>{snapshot.outboxCount}</strong>
            <p className="supporting stats-card-copy">
              {snapshot.outboxCount > 0 ? "Queued for uplink when the channel opens." : "Local log and uplink are aligned."}
            </p>
          </article>
          <article className="mini-card panel">
            <span>Uplink Status</span>
            <strong>{syncStatusToneText(syncStatus.tone)}</strong>
            <p className="supporting stats-card-copy">{syncStatus.message}</p>
          </article>
          <article className="mini-card panel">
            <span>Last Contact</span>
            <strong>{snapshot.lastSyncAt ?? "No contact yet"}</strong>
            <p className="supporting stats-card-copy">{isOnline ? "Online" : "Offline"}</p>
          </article>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>Uplink</h2>
            <div className="row-actions">
              <button className="ghost-button small-button" onClick={handleSaveServerUrl} disabled={isWorking}>
                Save Endpoint
              </button>
              <button
                className="primary-button small-button"
                onClick={handleSyncNow}
                disabled={isWorking || syncStatus.tone === "syncing"}
              >
                Sync Now
              </button>
            </div>
          </div>

          <label className="mini-field">
            <span>Endpoint</span>
            <input
              value={serverUrlDraft}
              onChange={(event) => setServerUrlDraft(event.target.value)}
              placeholder="http://localhost:8787"
            />
          </label>

          <div className="sync-state-card">
            <div className="sync-state-row">
              <span className={`status-pill status-pill-${syncStatus.tone}`}>{syncStatusToneText(syncStatus.tone)}</span>
              <span className="supporting">{isOnline ? "Auto uplink enabled" : "Storing offline logs"}</span>
            </div>
            <p className="supporting sync-state-copy">{syncStatus.message}</p>

            <div className="sync-stat-row">
              <div>
                <span>Uploaded</span>
                <strong>{syncStatus.pushedCount}</strong>
              </div>
              <div>
                <span>Applied</span>
                <strong>{syncStatus.pulledCount}</strong>
              </div>
              <div>
                <span>Conflicts</span>
                <strong>{syncStatus.conflictCount}</strong>
              </div>
            </div>
          </div>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>Alert Channel</h2>
            <span className="tag-pill">{notificationPermissionText(notificationPermission)}</span>
          </div>

          <p className="supporting">Used for routine pings and burn-cycle alerts.</p>

          <div className="button-row">
            <button
              className="ghost-button"
              onClick={handleRequestNotificationPermission}
              disabled={runtimeMode !== "native"}
            >
              Request Access
            </button>
            <button className="primary-button" onClick={handleSendTestNotification} disabled={runtimeMode !== "native"}>
              Test Ping
            </button>
          </div>
        </section>

        <section className="panel block-panel">
          <div className="section-head">
            <h2>Sync Key</h2>
            <button className="ghost-button small-button" onClick={handleRegenerate} disabled={isWorking}>
              Rotate Key
            </button>
          </div>

          <div className="sync-key-card">
            <span>Current Key</span>
            <strong>{syncKey ?? "Stored on this device."}</strong>
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
          <div className="auth-kicker">MISSION LOG</div>
          <h1>Daily Check</h1>
          <p className="supporting">Warming the bridge and local archive.</p>
        </section>
      </main>
    );
  }

  if (!isUnlocked) {
    return (
      <main className="shell auth-shell">
        <section className="auth-card panel">
          <div className="auth-kicker">MISSION LOG</div>
          <h1>Daily Check</h1>
          <p className="supporting">Enter your sync key to reopen the bridge.</p>

          <label className="field">
            <span>Sync Key</span>
            <input
              autoFocus
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="Enter your uplink key"
            />
          </label>

          <div className="button-row">
            <button className="primary-button" onClick={handleUnlock} disabled={isWorking}>
              Enter Bridge
            </button>
            <button className="ghost-button" onClick={handleRegenerate} disabled={isWorking}>
              Rotate Key
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
          <div className="app-header-meta">
            <span className="mission-badge">HAIL MISSION</span>
            <span className="mission-date">{missionDateLabel}</span>
          </div>
          <div className="app-title-block">
            <h1>{currentTabLabel}</h1>
            <p className="app-subtitle">{currentTabDescription}</p>
          </div>
        </header>

        {actionMessage ? <div className="toast-banner">{actionMessage}</div> : null}

        <section className="screen-body">{renderCurrentScreen()}</section>

        <nav className="tab-bar" aria-label="Primary navigation" style={{ "--tab-count": tabs.length } as CSSProperties}>
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
