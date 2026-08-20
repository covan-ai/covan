-- Agent brainstorming mode: 'normal' (default) answers directly;
-- 'brainstorm' layers a facilitation instruction block on top of the persona.
alter table public.agents
  add column mode text not null default 'normal';

alter table public.agents
  add constraint agents_mode_check check (mode in ('normal', 'brainstorm'));
