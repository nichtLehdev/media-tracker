CREATE TABLE "registration_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"server_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "server_accounts" (
	"server_id" uuid NOT NULL,
	"jellyfin_user_id" text NOT NULL,
	"jellyfin_username" text,
	"user_id" uuid,
	"link_state" text DEFAULT 'unlinked' NOT NULL,
	"linked_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_accounts_server_id_jellyfin_user_id_pk" PRIMARY KEY("server_id","jellyfin_user_id"),
	CONSTRAINT "server_accounts_link_state_check" CHECK ("server_accounts"."link_state" IN ('unlinked','pending','linked','rejected'))
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"plugin_version" text,
	"jellyfin_version" text,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"discord_id" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"announce_watches" boolean DEFAULT true NOT NULL,
	"history_visibility" text DEFAULT 'members' NOT NULL,
	"nowplaying_visibility" text DEFAULT 'members' NOT NULL,
	CONSTRAINT "users_discord_id_unique" UNIQUE("discord_id"),
	CONSTRAINT "users_history_visibility_check" CHECK ("users"."history_visibility" IN ('members','private')),
	CONSTRAINT "users_nowplaying_visibility_check" CHECK ("users"."nowplaying_visibility" IN ('members','private'))
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"show_id" uuid NOT NULL,
	"season" integer NOT NULL,
	"number" integer NOT NULL,
	"tmdb_id" integer,
	"title" text,
	"air_date" date,
	"runtime_min" integer,
	CONSTRAINT "episodes_show_id_season_number_unique" UNIQUE("show_id","season","number")
);
--> statement-breakpoint
CREATE TABLE "media_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"imdb_id" text,
	"tvdb_id" integer,
	"title" text NOT NULL,
	"year" integer,
	"runtime_min" integer,
	"poster_path" text,
	"overview" text,
	"episode_count" integer,
	"metadata_refreshed_at" timestamp with time zone,
	CONSTRAINT "media_items_kind_tmdb_id_unique" UNIQUE("kind","tmdb_id"),
	CONSTRAINT "media_items_kind_check" CHECK ("media_items"."kind" IN ('movie','show'))
);
--> statement-breakpoint
CREATE TABLE "playback_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"jellyfin_session_id" text NOT NULL,
	"media_item_id" uuid NOT NULL,
	"episode_id" uuid,
	"position_sec" integer,
	"runtime_sec" integer,
	"is_paused" boolean DEFAULT false NOT NULL,
	"device" text,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "playback_sessions_server_id_jellyfin_session_id_unique" UNIQUE("server_id","jellyfin_session_id")
);
--> statement-breakpoint
CREATE TABLE "watch_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"media_item_id" uuid NOT NULL,
	"episode_id" uuid,
	"watched_at" timestamp with time zone NOT NULL,
	"watched_at_is_approximate" boolean DEFAULT false NOT NULL,
	"is_rewatch" boolean DEFAULT false NOT NULL,
	"progress_pct" smallint,
	"source" text NOT NULL,
	"source_server_id" uuid,
	"idempotency_key" text,
	"announced" boolean DEFAULT false NOT NULL,
	"announce_suppressed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_events_source_server_id_idempotency_key_unique" UNIQUE("source_server_id","idempotency_key"),
	CONSTRAINT "watch_events_source_check" CHECK ("watch_events"."source" IN ('jellyfin','import_trakt','import_simkl','manual'))
);
--> statement-breakpoint
CREATE TABLE "library_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"media_item_id" uuid NOT NULL,
	"episode_id" uuid,
	"jellyfin_item_id" text NOT NULL,
	"audio_langs" text[] DEFAULT '{}' NOT NULL,
	"subtitle_langs" text[] DEFAULT '{}' NOT NULL,
	"video_height" integer,
	"video_range" text,
	"media_profile" jsonb,
	"profile_synced_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_confirmed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unmatched_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"jellyfin_item_id" text NOT NULL,
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_media_item_id" uuid
);
--> statement-breakpoint
ALTER TABLE "registration_codes" ADD CONSTRAINT "registration_codes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_codes" ADD CONSTRAINT "registration_codes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_accounts" ADD CONSTRAINT "server_accounts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_accounts" ADD CONSTRAINT "server_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_show_id_media_items_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_source_server_id_servers_id_fk" FOREIGN KEY ("source_server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_items" ADD CONSTRAINT "unmatched_items_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_items" ADD CONSTRAINT "unmatched_items_resolved_media_item_id_media_items_id_fk" FOREIGN KEY ("resolved_media_item_id") REFERENCES "public"."media_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_accounts_user_id_index" ON "server_accounts" USING btree ("user_id") WHERE link_state = 'linked';--> statement-breakpoint
CREATE INDEX "playback_sessions_expires_at_index" ON "playback_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "watch_events_user_id_watched_at_index" ON "watch_events" USING btree ("user_id","watched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "watch_events_user_id_media_item_id_index" ON "watch_events" USING btree ("user_id","media_item_id");--> statement-breakpoint
CREATE INDEX "watch_events_user_id_episode_id_index" ON "watch_events" USING btree ("user_id","episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_entries_identity" ON "library_entries" USING btree ("server_id","jellyfin_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_entries_logical" ON "library_entries" USING btree ("user_id","server_id","media_item_id",COALESCE(episode_id, '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "library_entries_media_item_id_index" ON "library_entries" USING btree ("media_item_id");--> statement-breakpoint
CREATE INDEX "library_entries_audio_langs_index" ON "library_entries" USING gin ("audio_langs");--> statement-breakpoint
CREATE INDEX "library_entries_subtitle_langs_index" ON "library_entries" USING gin ("subtitle_langs");--> statement-breakpoint
CREATE UNIQUE INDEX "unmatched_items_server_id_jellyfin_item_id_unique" ON "unmatched_items" USING btree ("server_id","jellyfin_item_id");