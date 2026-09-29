-- Fase 5.1: optional, admin-editable context for the GPT intent classifier.
-- This text is NEVER sent to the customer (the reply always comes from
-- automation_faqs.answer) — it only helps the classifier decide which FAQ a
-- message matches, especially when title/aliases alone are ambiguous.
alter table public.automation_faqs
  add column classifier_description text;
