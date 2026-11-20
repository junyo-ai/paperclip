-- paperclip:migration-compat online_compatible: The replacement CHECK constraints only widen the allowed provider values; every value the previous release can write already satisfies them, and the momentary exclusive lock covers two small catalog tables.
ALTER TABLE "ai_provider_defaults" DROP CONSTRAINT "ai_provider_defaults_provider_check";--> statement-breakpoint
ALTER TABLE "ai_provider_defaults" ADD CONSTRAINT "ai_provider_defaults_provider_check" CHECK ("ai_provider_defaults"."provider" in ('anthropic','openai','openrouter','xai','google','github','deepseek','zhipu','moonshot','minimax'));--> statement-breakpoint
ALTER TABLE "ai_connection_defaults" DROP CONSTRAINT "ai_connection_defaults_provider_check";--> statement-breakpoint
ALTER TABLE "ai_connection_defaults" ADD CONSTRAINT "ai_connection_defaults_provider_check" CHECK ("ai_connection_defaults"."provider" in ('anthropic','openai','openrouter','xai','google','github','deepseek','zhipu','moonshot','minimax'));
