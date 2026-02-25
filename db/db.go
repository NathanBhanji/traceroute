// Package db manages the SQLite trace history database.
package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// DB wraps a SQLite connection for trace history.
type DB struct {
	conn *sql.DB
}

// TraceRecord is a summary row returned when listing history.
type TraceRecord struct {
	ID           int64   `json:"id"`
	Destination  string  `json:"destination"`
	CreatedAt    string  `json:"createdAt"` // RFC3339
	HopCount     int     `json:"hopCount"`
	TimeoutCount int     `json:"timeoutCount"`
	TotalRTT     float64 `json:"totalRtt"` // last hop RTT ms, 0 if not reached
}

// HopRecord mirrors traceroute.Hop but belongs to a stored trace.
type HopRecord struct {
	TTL      int     `json:"ttl"`
	IP       string  `json:"ip"`
	Hostname string  `json:"hostname"`
	RTT      float64 `json:"rtt"`
	Success  bool    `json:"success"`
	IsFinal  bool    `json:"isFinal"`
}

// Open opens (or creates) the SQLite database at the platform data dir.
func Open() (*DB, error) {
	dir, err := dataDir()
	if err != nil {
		return nil, fmt.Errorf("db: cannot find data dir: %w", err)
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("db: cannot create data dir: %w", err)
	}

	path := filepath.Join(dir, "history.db")
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("db: cannot open %s: %w", path, err)
	}

	conn.SetMaxOpenConns(1) // SQLite is single-writer
	if err := migrate(conn); err != nil {
		return nil, err
	}
	return &DB{conn: conn}, nil
}

// Close closes the database connection.
func (d *DB) Close() error {
	return d.conn.Close()
}

// SaveTrace writes a complete trace to the database and returns its ID.
func (d *DB) SaveTrace(destination string, hops []HopRecord) (int64, error) {
	hopCount := 0
	timeoutCount := 0
	totalRTT := 0.0
	for _, h := range hops {
		if h.Success {
			hopCount++
			if h.IsFinal {
				totalRTT = h.RTT
			}
		} else {
			timeoutCount++
		}
	}

	tx, err := d.conn.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	res, err := tx.Exec(
		`INSERT INTO traces (destination, created_at, hop_count, timeout_count, total_rtt)
		 VALUES (?, ?, ?, ?, ?)`,
		destination,
		time.Now().UTC().Format(time.RFC3339),
		hopCount,
		timeoutCount,
		totalRTT,
	)
	if err != nil {
		return 0, err
	}
	traceID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}

	stmt, err := tx.Prepare(
		`INSERT INTO hops (trace_id, ttl, ip, hostname, rtt, success, is_final)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()

	for _, h := range hops {
		if _, err := stmt.Exec(traceID, h.TTL, h.IP, h.Hostname, h.RTT, h.Success, h.IsFinal); err != nil {
			return 0, err
		}
	}

	return traceID, tx.Commit()
}

// ListTraces returns the N most recent traces for a destination.
// If destination is empty, all destinations are returned.
func (d *DB) ListTraces(destination string, limit int) ([]TraceRecord, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if destination == "" {
		rows, err = d.conn.Query(
			`SELECT id, destination, created_at, hop_count, timeout_count, total_rtt
			 FROM traces
			 ORDER BY created_at DESC
			 LIMIT ?`,
			limit,
		)
	} else {
		rows, err = d.conn.Query(
			`SELECT id, destination, created_at, hop_count, timeout_count, total_rtt
			 FROM traces
			 WHERE destination = ?
			 ORDER BY created_at DESC
			 LIMIT ?`,
			destination, limit,
		)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var records []TraceRecord
	for rows.Next() {
		var r TraceRecord
		if err := rows.Scan(&r.ID, &r.Destination, &r.CreatedAt, &r.HopCount, &r.TimeoutCount, &r.TotalRTT); err != nil {
			return nil, err
		}
		records = append(records, r)
	}
	return records, rows.Err()
}

// GetTrace returns the hops for a specific trace ID.
func (d *DB) GetTrace(id int64) ([]HopRecord, error) {
	rows, err := d.conn.Query(
		`SELECT ttl, ip, hostname, rtt, success, is_final
		 FROM hops WHERE trace_id = ? ORDER BY ttl`,
		id,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var hops []HopRecord
	for rows.Next() {
		var h HopRecord
		if err := rows.Scan(&h.TTL, &h.IP, &h.Hostname, &h.RTT, &h.Success, &h.IsFinal); err != nil {
			return nil, err
		}
		hops = append(hops, h)
	}
	return hops, rows.Err()
}

// DeleteTrace removes a trace and its hops.
func (d *DB) DeleteTrace(id int64) error {
	_, err := d.conn.Exec(`DELETE FROM traces WHERE id = ?`, id)
	return err
}

// --- internal ---

func migrate(conn *sql.DB) error {
	_, err := conn.Exec(`
		CREATE TABLE IF NOT EXISTS traces (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			destination  TEXT    NOT NULL,
			created_at   TEXT    NOT NULL,
			hop_count    INTEGER NOT NULL DEFAULT 0,
			timeout_count INTEGER NOT NULL DEFAULT 0,
			total_rtt    REAL    NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_traces_dest ON traces(destination, created_at DESC);

		CREATE TABLE IF NOT EXISTS hops (
			id        INTEGER PRIMARY KEY AUTOINCREMENT,
			trace_id  INTEGER NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
			ttl       INTEGER NOT NULL,
			ip        TEXT    NOT NULL DEFAULT '',
			hostname  TEXT    NOT NULL DEFAULT '',
			rtt       REAL    NOT NULL DEFAULT 0,
			success   INTEGER NOT NULL DEFAULT 0,
			is_final  INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_hops_trace ON hops(trace_id);

		PRAGMA foreign_keys = ON;
		PRAGMA journal_mode = WAL;
	`)
	return err
}

func dataDir() (string, error) {
	// macOS: ~/Library/Application Support/traceroute
	// Linux: ~/.local/share/traceroute
	// Windows: %APPDATA%\traceroute
	base, err := os.UserConfigDir()
	if err != nil {
		base, err = os.UserHomeDir()
		if err != nil {
			return "", err
		}
	}
	return filepath.Join(base, "traceroute"), nil
}
