CREATE TABLE "role_template_create_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"template_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"changelog" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"working_spec" jsonb NOT NULL,
	"deprecation_reason" text,
	"source_issue_id" uuid,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"router_visible" boolean DEFAULT false NOT NULL,
	"dispatch_weight" integer DEFAULT 0 NOT NULL,
	"capability_tags" text[] DEFAULT '{}' NOT NULL,
	"published_at" timestamp with time zone,
	"deprecated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "hired_from_template_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "hired_from_template_version" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role_template_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "role_template_create_receipts" ADD CONSTRAINT "role_template_create_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_template_create_receipts" ADD CONSTRAINT "role_template_create_receipts_template_id_role_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."role_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_template_versions" ADD CONSTRAINT "role_template_versions_template_id_role_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."role_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_template_versions" ADD CONSTRAINT "role_template_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_templates" ADD CONSTRAINT "role_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_templates" ADD CONSTRAINT "role_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_template_create_receipts_key_idx" ON "role_template_create_receipts" USING btree ("company_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "role_template_versions_template_version_idx" ON "role_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "role_templates_company_key_live_idx" ON "role_templates" USING btree ("company_id","key") WHERE ("role_templates"."deleted_at" is null);--> statement-breakpoint
CREATE INDEX "role_templates_company_status_idx" ON "role_templates" USING btree ("company_id","status") WHERE ("role_templates"."deleted_at" is null);--> statement-breakpoint
CREATE INDEX "role_templates_capability_tags_idx" ON "role_templates" USING gin ("capability_tags");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_hired_from_template_id_role_templates_id_fk" FOREIGN KEY ("hired_from_template_id") REFERENCES "public"."role_templates"("id") ON DELETE set null ON UPDATE no action NOT VALID;