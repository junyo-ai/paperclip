-- paperclip:migration-compat online_compatible: Concurrent index build takes no write-blocking lock on agents; previous-release queries never touch these columns, and IF NOT EXISTS keeps the file retry-safe.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_company_hired_from_template_idx" ON "agents" USING btree ("company_id","hired_from_template_id");
