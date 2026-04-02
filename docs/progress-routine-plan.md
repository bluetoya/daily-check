# Progress Routine Plan

## Goal

Add a new `progress` routine type alongside the existing check-based routine type.

This type is meant for goals that are completed gradually within a day, such as:

- water intake
- reading pages
- study minutes
- walking steps

The main interaction model is:

- `오늘` 화면: number + slider + quick adjust buttons
- `주간 체크` 화면: color intensity only

## Product Definition

The app will support two routine types.

### 1. Check Routine

- Current behavior
- Daily state is `done` or `not done`
- Best for binary habits such as stretching or planning

### 2. Progress Routine

- Daily state is based on a numeric value
- Users can increase or decrease the current value
- Completion is calculated automatically when the daily target is reached
- Best for goals such as `2000 ml`, `60 min`, `30 pages`

## UX Rules

### Today Screen

Check routine:

- checkbox
- title
- reminder time

Progress routine:

- title
- current value / target value / unit
- progress percentage
- slider
- quick adjust buttons

Example:

```text
물 마시기
1250 / 2000 ml
[ slider ]
-250  +250  +500
```

Rules:

- slider min is `0`
- slider max is `targetValue`
- slider step is `stepValue`
- quick buttons may both increase and decrease
- current value cannot go below `0`
- MVP keeps current value capped at `targetValue`

### Weekly Screen

Check routine:

- current binary cell behavior stays

Progress routine:

- no numbers in cells
- no slider in weekly grid
- use color intensity based on progress percent

Suggested levels:

- `0%`: empty
- `1% to 49%`: light accent
- `50% to 99%`: medium accent
- `100%`: full accent

Weekly screen remains a summary view, not an editing-heavy view.

### Routine Editor

Add a routine type selector.

Type options:

- `check`
- `progress`

When `progress` is selected, show:

- target value
- unit
- step value
- quick adjust values

When `check` is selected:

- keep the current form behavior
- hide progress-only fields

## Data Model

### Routine

Add the following fields to the routine model:

```text
id
title
type
frequency
weekday_mask
reminder
accent
focus_minutes
break_minutes
target_value
unit
step_value
quick_adjust_values
created_at
updated_at
deleted_at
```

Definitions:

- `type`
  - `check`
  - `progress`
- `target_value`
  - numeric daily goal
  - nullable for check routines
- `unit`
  - examples: `ml`, `min`, `page`, `count`
- `step_value`
  - slider step
  - examples: `250`, `10`, `5`
- `quick_adjust_values`
  - JSON array of numbers
  - examples: `[-250, 250, 500]`

### RoutineDailyRecord

Current check storage should evolve into a daily record model that supports both types.

Recommended fields:

```text
routine_id
date
completed
progress_value
updated_at
```

Behavior:

- check routine
  - `completed` is explicitly toggled
  - `progress_value` is `NULL` or `1`
- progress routine
  - `progress_value` is stored
  - `completed` is derived as `progress_value >= target_value`

## SQLite Change Plan

### Existing `routines` table

Add columns:

```sql
ALTER TABLE routines ADD COLUMN type TEXT NOT NULL DEFAULT 'check';
ALTER TABLE routines ADD COLUMN target_value INTEGER;
ALTER TABLE routines ADD COLUMN unit TEXT;
ALTER TABLE routines ADD COLUMN step_value INTEGER;
ALTER TABLE routines ADD COLUMN quick_adjust_values TEXT;
```

Recommended defaults for old rows:

- `type = 'check'`
- `target_value = NULL`
- `unit = NULL`
- `step_value = NULL`
- `quick_adjust_values = NULL`

### Existing `routine_checks` table

Two options are possible.

#### Option A. Extend current table

Add:

```sql
ALTER TABLE routine_checks ADD COLUMN completed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE routine_checks ADD COLUMN progress_value INTEGER;
```

This is the recommended MVP path because it minimizes rewrite scope.

Interpretation:

- check routine
  - row exists with `completed = 1`
- progress routine
  - row exists with `progress_value`
  - `completed` mirrors whether target is reached

#### Option B. Replace with `routine_daily_records`

This is cleaner long-term, but larger in scope.

For now, use Option A.

## Sync Model

Remote routine payload must add:

- `type`
- `targetValue`
- `unit`
- `stepValue`
- `quickAdjustValues`

Remote routine check payload must support:

- `completed`
- `progressValue`

Conflict handling rule remains:

- latest `updated_at` wins

This is especially important for progress routines because both increase and decrease must sync correctly.

## Frontend State Changes

### Type updates

Update `Routine` and `RoutineDraft` in `src/App.tsx`.

Add:

- `type`
- `targetValue`
- `unit`
- `stepValue`
- `quickAdjustValues`

### Derived helpers

Add helpers for:

- progress percent
- slider label formatting
- quick adjust application
- weekly color tier selection
- completion derivation for progress routines

### Today screen rendering

Render by routine type.

Check routine:

- keep existing card

Progress routine:

- show numeric progress
- show slider
- show quick adjust buttons
- show derived completion state

### Weekly screen rendering

Check routine:

- current boolean cell styles

Progress routine:

- render cell class by progress percent tier
- no checkbox-like toggle UI

## Backend Command Changes

### Existing commands to update

- `create_routine`
- `update_routine`
- `load_snapshot`
- sync payload builders
- remote apply logic

### New command recommended

Add a dedicated progress update command:

```text
update_routine_progress(routineId, date, value)
```

This is better than overloading check toggle behavior.

Optional helper:

```text
adjust_routine_progress(routineId, date, delta)
```

For MVP, one absolute-value command is enough because slider and button changes can both call it.

## Validation Rules

For progress routines:

- `targetValue > 0`
- `stepValue > 0`
- `unit` must not be empty
- `quickAdjustValues` must be numeric

For check routines:

- progress-only fields may be empty

## Suggested UI Defaults

### Water Intake

- type: `progress`
- target: `2000`
- unit: `ml`
- step: `250`
- quick adjust: `[-250, 250, 500]`

### Study Time

- type: `progress`
- target: `60`
- unit: `min`
- step: `10`
- quick adjust: `[-10, 10, 20]`

### Reading

- type: `progress`
- target: `30`
- unit: `page`
- step: `5`
- quick adjust: `[-5, 5, 10]`

## Implementation Order

### Phase 1. Schema and model

- add routine columns
- extend daily record storage
- add migration
- update Rust structs

### Phase 2. Backend logic

- update create/update routine logic
- update snapshot loading
- add progress update command
- update sync payloads and remote apply logic

### Phase 3. Today screen

- render progress routine cards
- add slider
- add quick adjust buttons
- show numeric progress and percent

### Phase 4. Weekly screen

- add progress color tiers
- render progress cells with intensity

### Phase 5. Polish

- validation messages
- empty-state handling
- stats integration
- Android touch tuning for slider interaction

## Recommended MVP Scope

Include:

- routine type switch
- progress routine fields
- today slider
- quick adjust buttons
- weekly color intensity
- sync support for progress value

Exclude for now:

- progress history timeline
- per-step event log
- undo stack
- over-target values
- mixed-type advanced analytics

## Notes

This should be implemented as a reusable numeric routine model, not as a special-case water feature.

That keeps the design useful for:

- water
- study
- reading
- exercise counts
- step goals
