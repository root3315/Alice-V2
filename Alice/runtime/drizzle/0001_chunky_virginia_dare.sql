ALTER TABLE `narrative_threads` ADD `source` text DEFAULT 'conversation';--> statement-breakpoint

-- ADR-190: 回填已有 system 线程
UPDATE narrative_threads SET source = 'system'
  WHERE title LIKE 'anomaly_%'
     OR title LIKE 'evaluate_%'
     OR title LIKE 'morning_%'
     OR title LIKE 'weekly_%';--> statement-breakpoint

-- ADR-190: 清理 zombie anomaly 线程（图已 resolved 但 DB 仍 open）
UPDATE narrative_threads SET status = 'resolved', resolved_tick = created_tick + 100
  WHERE source = 'system' AND status IN ('open', 'active')
    AND title LIKE 'anomaly_%';