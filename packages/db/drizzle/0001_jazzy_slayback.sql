CREATE TABLE "library_sync_quarantine" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_ids" uuid[] NOT NULL,
	"entry_count" integer NOT NULL,
	"library_count" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"occurrences" smallint DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "library_sync_quarantine_resolution_check" CHECK ("library_sync_quarantine"."resolution" IN ('applied','dismissed','auto_applied'))
);
--> statement-breakpoint
ALTER TABLE "library_sync_quarantine" ADD CONSTRAINT "library_sync_quarantine_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_sync_quarantine" ADD CONSTRAINT "library_sync_quarantine_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_sync_quarantine_open_fingerprint" ON "library_sync_quarantine" USING btree ("server_id","user_id","fingerprint") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "library_sync_quarantine_pending" ON "library_sync_quarantine" USING btree ("server_id") WHERE resolved_at IS NULL;