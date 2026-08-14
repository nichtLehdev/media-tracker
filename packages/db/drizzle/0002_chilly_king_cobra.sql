CREATE TABLE "playback_session_archive" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"media_item_id" uuid NOT NULL,
	"episode_id" uuid,
	"device" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"position_sec" integer,
	"runtime_sec" integer,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playback_session_archive" ADD CONSTRAINT "playback_session_archive_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_session_archive" ADD CONSTRAINT "playback_session_archive_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_session_archive" ADD CONSTRAINT "playback_session_archive_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_session_archive" ADD CONSTRAINT "playback_session_archive_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playback_session_archive_user_id_started_at_index" ON "playback_session_archive" USING btree ("user_id","started_at" DESC NULLS LAST);