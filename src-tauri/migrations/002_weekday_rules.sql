UPDATE routines
SET weekday_mask = '1111111'
WHERE weekday_mask IS NULL OR TRIM(weekday_mask) = '';

UPDATE routines
SET frequency = 'Daily',
    weekday_mask = '1111111'
WHERE frequency = 'Daily';

UPDATE routines
SET frequency = 'Weekdays',
    weekday_mask = '0111110'
WHERE frequency = 'Weekdays';

UPDATE routines
SET frequency = 'Weekends',
    weekday_mask = '1000001'
WHERE frequency = 'Weekends';

UPDATE routines
SET frequency = 'CustomDays',
    weekday_mask = '0101010'
WHERE frequency = 'Mon/Wed/Fri';

UPDATE routines
SET frequency = 'Weekends',
    weekday_mask = '1000001'
WHERE frequency = 'Monthly';

UPDATE routines
SET title = '아침 계획'
WHERE title = 'Morning planning';

UPDATE routines
SET title = '스트레칭'
WHERE title = 'Stretch reset';

UPDATE routines
SET title = '받은 편지함 정리'
WHERE title = 'Inbox cleanup';

UPDATE routines
SET title = '주말 회고'
WHERE title = 'Monthly review';
