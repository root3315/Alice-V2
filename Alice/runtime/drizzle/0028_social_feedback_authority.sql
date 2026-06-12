ALTER TABLE `intervention_outcome_evidence` ADD `semantic_reception` text;
--> statement-breakpoint
ALTER TABLE `intervention_outcome_evidence` ADD `semantic_confidence` real;
--> statement-breakpoint
ALTER TABLE `intervention_outcome_evidence` ADD `semantic_rationale` text;
--> statement-breakpoint
ALTER TABLE `intervention_outcome_evidence` ADD `semantic_source_message_log_ids_json` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `intervention_outcome_evidence` ADD `semantic_authority` text DEFAULT 'deterministic' NOT NULL;
--> statement-breakpoint
ALTER TABLE `intervention_outcome_evidence` ADD `semantic_model` text;
