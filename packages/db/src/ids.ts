import { uuidv7 } from 'uuidv7';

/**
 * All ids are UUIDv7: time-ordered, so index locality on append-heavy tables
 * (watch_events, library_entries) stays good.
 */
export const newId = (): string => uuidv7();
