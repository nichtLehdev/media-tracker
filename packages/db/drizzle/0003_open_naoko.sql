CREATE TABLE "library_syncs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"jellyfin_user_id" text NOT NULL,
	"estimated_count" integer,
	"state" text DEFAULT 'open' NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"unmatched_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "library_syncs_state_check" CHECK ("library_syncs"."state" IN ('open','finished','abandoned'))
);
--> statement-breakpoint
DROP INDEX "library_entries_identity";--> statement-breakpoint
ALTER TABLE "library_syncs" ADD CONSTRAINT "library_syncs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_syncs" ADD CONSTRAINT "library_syncs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_syncs_open" ON "library_syncs" USING btree ("server_id","user_id") WHERE state = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "library_entries_identity" ON "library_entries" USING btree ("server_id","user_id","jellyfin_item_id");