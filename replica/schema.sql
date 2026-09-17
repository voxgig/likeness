-- likeness replica: the SQLite schema.
--
-- A CACHE. Every table records where a row came from and when, nothing here is
-- a source of truth, and deleting this file loses nothing.
--
-- One schema, generated queries, five ports. The only per-port code is "run
-- this statement, give me rows".

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Schema version, checked at open. A replica written by an older likeness is
-- discarded and rebuilt rather than migrated: it is a cache, so rebuilding is
-- always correct and always cheaper than a migration nobody tested.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The projected note. Column names match the entity shape in spec/def/note.aon
-- so the mapping is nominal rather than a translation table.
CREATE TABLE IF NOT EXISTS note (
  lid       TEXT PRIMARY KEY,
  source    TEXT NOT NULL,
  instance  TEXT NOT NULL,
  id        TEXT NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT,
  space     TEXT,
  status    TEXT,
  state     TEXT,
  url       TEXT NOT NULL,
  created   TEXT NOT NULL,
  updated   TEXT NOT NULL,
  version   TEXT,
  raw       TEXT,

  -- Freshness. A cache that cannot say how old it is invites the mistake this
  -- design exists to avoid.
  synced    TEXT NOT NULL,
  pending   INTEGER NOT NULL DEFAULT 0,

  UNIQUE (instance, id)
);

CREATE TABLE IF NOT EXISTS space (
  lid      TEXT PRIMARY KEY,
  source   TEXT NOT NULL,
  instance TEXT NOT NULL,
  id       TEXT NOT NULL,
  title    TEXT NOT NULL,
  parent   TEXT,
  url      TEXT NOT NULL,
  raw      TEXT,
  synced   TEXT NOT NULL,
  pending  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (instance, id)
);

CREATE TABLE IF NOT EXISTS tag (
  lid      TEXT PRIMARY KEY,
  source   TEXT NOT NULL,
  instance TEXT NOT NULL,
  id       TEXT NOT NULL,
  name     TEXT NOT NULL,
  raw      TEXT,
  synced   TEXT NOT NULL,
  pending  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (instance, id)
);

-- A note's tags. Joplin cannot write this association through its SDK, so for
-- that source the table is read-only in practice - which the capability matrix
-- already records.
CREATE TABLE IF NOT EXISTS note_tag (
  note_lid TEXT NOT NULL REFERENCES note(lid) ON DELETE CASCADE,
  tag_lid  TEXT NOT NULL REFERENCES tag(lid)  ON DELETE CASCADE,
  PRIMARY KEY (note_lid, tag_lid)
);

-- Links between notes, including dangling ones. A wikilink to a note that does
-- not exist is normal in a vault, and dropping it would hide the broken
-- reference the user most needs to see - so `resolved` is a column, not a
-- filter applied before storage.
CREATE TABLE IF NOT EXISTS link (
  source    TEXT NOT NULL,
  instance  TEXT NOT NULL,
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  kind      TEXT NOT NULL,
  resolved  INTEGER NOT NULL,
  reason    TEXT,
  synced    TEXT NOT NULL,
  PRIMARY KEY (instance, from_id, to_id, kind)
);

-- Declared same-as pairs, from a project file. Merging is declared and never
-- inferred, so nothing writes to this table except a project load.
CREATE TABLE IF NOT EXISTS same_as (
  a_lid TEXT NOT NULL,
  b_lid TEXT NOT NULL,
  PRIMARY KEY (a_lid, b_lid)
);

-- THE POINT OF THE WHOLE EXERCISE. No source's SDK exposes a search operation,
-- so without this there is no search at all. `content=note` makes it an
-- external-content index: the text lives once, in the note table.
CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5 (
  title, body,
  content = 'note',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS note_ai AFTER INSERT ON note BEGIN
  INSERT INTO note_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS note_ad AFTER DELETE ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS note_au AFTER UPDATE ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
  INSERT INTO note_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Ordering is part of the contract: the total sort order is requested key,
-- then updated descending, then lid ascending, and it has to be reproducible
-- in five ports. BINARY collation is the default and is the only one every
-- SQLite build agrees on, so nothing here asks for NOCASE or a locale.
CREATE INDEX IF NOT EXISTS note_updated ON note(updated DESC, lid ASC);
CREATE INDEX IF NOT EXISTS note_instance ON note(instance, updated DESC);
CREATE INDEX IF NOT EXISTS note_space ON note(space);
