CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_company_hired_from_template_idx" ON "agents" USING btree ("company_id","hired_from_template_id");
