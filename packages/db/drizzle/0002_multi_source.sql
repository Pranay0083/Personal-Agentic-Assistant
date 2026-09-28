ALTER TABLE "accounts" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "route_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cursor" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "accounts_route_keys_idx" ON "accounts" USING gin ("route_keys");--> statement-breakpoint
CREATE INDEX "subscriptions_external_sub_idx" ON "subscriptions" USING btree ("external_sub_id");--> statement-breakpoint
-- Gmail's watch becomes the `mail` source and carries the account's old cursor.
UPDATE "subscriptions" s SET "kind" = 'mail', "cursor" = a."sync_cursor"
  FROM "accounts" a WHERE a."id" = s."account_id" AND s."kind" = 'gmail.watch';--> statement-breakpoint
INSERT INTO "subscriptions" ("account_id", "kind", "cursor")
  SELECT a."id", 'mail', a."sync_cursor" FROM "accounts" a
  WHERE a."provider" = 'gmail' AND a."sync_cursor" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."account_id" = a."id" AND s."kind" = 'mail');--> statement-breakpoint
UPDATE "accounts" SET "route_keys" = ARRAY["external_id"] WHERE "provider" = 'gmail' AND "route_keys" = '{}';
