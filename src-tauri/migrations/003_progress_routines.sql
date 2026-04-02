UPDATE routines
SET type = 'check'
WHERE type IS NULL OR TRIM(type) = '';

UPDATE routines
SET quick_adjust_values = '[]'
WHERE quick_adjust_values IS NULL OR TRIM(quick_adjust_values) = '';

UPDATE routine_checks
SET completed = 1
WHERE completed IS NULL;
