/**
 * What an agent knows about Covan itself, by topic, for the `covan_guide` tool
 * (`lib/harness/tools/covan-guide.ts`).
 *
 * WHY A TOOL AND NOT THE PROMPT. Somebody asking "what can I do with Covan?"
 * is rare next to everything else an agent is asked, and this text is a few
 * thousand tokens. In the system prefix it would be paid for on every turn of
 * every conversation; behind a tool it is paid for on the turns that need it.
 * The prefix carries one short paragraph (`ABOUT_COVAN` in `lib/prompt.ts`)
 * that says what Covan is and points here.
 *
 * WHERE IT COMES FROM. The README, `docs/` and the English strings of the
 * screens in `src/routes` and `src/components` — the names below (Threads,
 * Knowledge, Routines, Configuration, Settings → Usage and billing) are the
 * ones the interface shows, so an agent can point at something a person can
 * find. When a screen is renamed, this is a file to change with it.
 *
 * What it deliberately leaves out: prices and plan names, which are the hosted
 * service's and change; and how anything is built, which is not what somebody
 * asking how to use the product wants to hear.
 */

export const GUIDE_TOPICS = [
  "overview",
  "getting_started",
  "agents",
  "chat",
  "knowledge",
  "documents",
  "routines",
  "integrations",
  "team",
  "settings_and_billing",
  "api",
] as const;

export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export const COVAN_GUIDE: Record<GuideTopic, string> = {
  overview: `# What Covan is

Covan is a workspace where a team builds AI agents together and talks to them. Everyone adds to what an agent knows; everyone gets their own conversation with it. What the agent knows is shared, the conversations are private unless somebody shares one.

What you can do with it:

- **Make agents** for a job — support, research, finance, operations, or anything you name. Each has a persona (its standing instructions), a model, and the folders of documents it reads.
- **Give them your knowledge.** Upload files into folders on the Knowledge page, sync a Google Drive folder or a Notion database, or add a web page. Answers name the documents they came from under **Sources**.
- **Let them act.** Connect apps and services under Settings → Integrations — about 1,500 apps (Gmail, Slack, HubSpot, GitHub and the like), your own database or HTTP API, and a real browser. Anything that changes data in another app asks you first.
- **Have them write documents.** Ask for a report, proposal or write-up and the agent writes it as a document beside the conversation, which you can save as Markdown, Word or PDF. Agents can also read and edit documents already in their folders.
- **Run them unattended.** A routine runs an agent on a schedule, on a webhook or when something happens in a connected app, and delivers the result to your Inbox, email, Slack or a webhook.
- **Work as a team.** Invite people, share an agent with some or all of them, share a thread, brainstorm on a shared idea board, and ask agents from Slack.

The sidebar holds Home, Inbox, Threads, Knowledge, Routines and Team, with Settings at the foot. Covan runs as a hosted service at covan.app, and the same software can be self-hosted.`,

  getting_started: `# Getting started

1. **Sign up.** The first run asks a few questions about you and your team, then helps you name the workspace.
2. **Make your first agent.** Name, icon and persona are pre-filled from a template; **Generate persona** writes the persona from the agent's name. Everything can be changed later on the agent's **Configuration** tab. To make another agent later, use **Create agent** on Home or **New agent** when you start a thread.
3. **Give it something to read.** Without documents an agent answers from general knowledge, which is not what Covan is for. Open the agent's **Knowledge** tab, create a folder, upload files into it, and attach the folder to the agent. The quickest route is to drop a file onto the chat, paste it, or use the paperclip: it goes into a folder of the agent's own and is attached at once, so you can ask about it in the next message. Starter documents (company overview, FAQ, glossary, how we work and others) are offered on the Knowledge tab if you have nothing written down yet.
4. **Ask it something.** Start a thread from the agent's **Threads** tab or **New thread**. A new thread is private to you. Check **Sources** under a reply to see which documents it was grounded in.
5. **Invite the team.** Open **Team** in the sidebar and use **Invite member**. Choose who can use each agent with **Share** on the agent.
6. **Connect apps** under Settings → Integrations, so the agent can look things up and act in the tools you already use.
7. **Set up a routine** under **Routines** → **New routine**, so the agent does a recurring job by itself — for example "Every Monday at 9, summarise last week's tickets for the team."

On the hosted service the workspace starts with free credits; Settings → Usage and billing shows the balance.`,

  agents: `# Agents

An agent is an assistant your team sets up for one job. Open one from the sidebar or Home; its pages are **Threads**, **Knowledge**, **Routines** and **Configuration**, with **Share** and a menu (pin it, start a new brainstorm, delete it) beside them.

On **Configuration** you set:

- **Name** and **Face** (one of eight marks, or two letters).
- **Persona** — the standing instructions every conversation starts from: who it is, who it serves, how it should answer. **Generate persona** drafts one from the name.
- **Model** — which AI model answers, plus **Temperature** (how much its wording varies) and **Thinking** (how long a reasoning model thinks before answering).
- **Knowledge** — the folders it can read (**Attach folder**).
- **Tools** — what it may use: web search when the team's documents don't have the answer, the browser, and connected apps, databases and HTTP APIs, each marked read-only or able to change things.
- **Sharing** and the **Danger** zone (delete).

Changing an agent's setup needs edit access; a viewer sees it read-only.

**Who can use it.** **Share** offers **Only me**, **Specific people**, or **Everyone in** the workspace, at three levels: **Can use** (talk to it), **Can edit** (change persona, model, tuning, folders and tool permissions) and **Full access** (share it, delete it, restore it). Workspace admins always have full access. Threads stay private to whoever starts them either way.

**Modes.** A thread is normal or **Brainstorm**. Brainstorm asks a question or two, generates many varied ideas, pressure-tests the strongest, and comes with a shared idea board.

A deleted agent can be restored for 30 days. Agents answer in whatever language you write to them in.`,

  chat: `# Threads (conversations)

A thread is one conversation with one agent. Start one with **New thread**, from an agent's **Threads** tab, or from Home. The **Threads** page in the sidebar lists yours and any shared with you; **Inbox** gathers what needs you — an agent waiting on an answer or an approval, finished routine runs, unread replies.

In a thread you can:

- **Attach files** with the paperclip, by pasting, or by dropping them on the chat. They go into the agent's own folder and can be asked about straight away.
- **Dictate** with the microphone instead of typing.
- **Pick the model for one message**, or answer again on another model. The agent's default is set on Configuration.
- **Edit** a question you asked; the agent answers again and earlier versions of the answer stay available.
- **See Sources** under a reply — the documents it was grounded in.
- **Write a report**: the report control, or typing \`/report\` followed by what it should cover, writes a document instead of a reply.
- **Search this thread**, rename it, or delete it.
- **Approve actions.** When the agent wants to do something in a connected app, a card asks first: **Just this once** or **Always allow this**. When it uses the browser you can watch, and **Take over** when a site needs you to sign in.

**Private and shared.** A thread is private to the person who started it. **Share with workspace** lets everyone in the workspace read it and write in it; only the person who started it can edit earlier messages or make it private again. A **Brainstorm** thread is shared from the start and has an **Idea board**: **Extract ideas** pulls candidate ideas from the conversation, and anyone in the thread can add, move and remove cards.

You can also ask an agent from Slack once Slack is connected (see integrations).`,

  knowledge: `# Knowledge

What an agent knows beyond its persona comes from **folders** of documents. A folder belongs to the workspace and is attached to one or more agents; an agent reads only the folders attached to it. Attaching or detaching is instant and deletes nothing.

**Where:** the **Knowledge** page in the sidebar shows every folder in the workspace, which agents read each one, and opens any file. An agent's **Knowledge** tab shows what that agent reads and lets you create a folder, upload, and attach.

**Adding documents:**

- Upload files into a folder (drag them in, or **Upload**). Accepted: Word, PowerPoint and Excel (including older .doc/.ppt/.xls), OpenDocument text, PDF with a text layer, Markdown, text, CSV, TSV, JSON, XML, HTML and RTF, up to 100 MB each. Images inside documents and scanned PDFs without text are not read — run OCR elsewhere first.
- Drop a file onto a chat: it goes into the agent's own folder.
- **Add a web page** by its address.
- **Add a source**: sync a Google Drive folder or a Notion database, kept up to date as pages are added, changed or removed.
- Routines can file what they deliver into a folder.

After upload a file shows **Queued**, **Indexing**, then **Indexed**. **Not indexed** means it could not be made searchable yet — **Reindex** from its menu retries.

**Who sees a folder:** a folder can be **Only you** or shared with the workspace. Members can upload, move and delete; viewers can read. Deleted files and folders sit under **Recently deleted** for 30 days.

**How answers use it:** for each question the agent searches its folders for the closest passages and answers from them, listing them under **Sources**. If nothing relevant is found it should say so rather than guess. Documents written as headings with short, self-contained sections answer best; the starter documents on an agent's Knowledge tab show the shape. **Worth revisiting** flags files old enough to doubt, and **Coverage** shows questions the documents did not answer.`,

  documents: `# Documents the agent writes and edits

**Writing a new document.** Ask an agent for a report, proposal, write-up or anything longer than a chat answer should be, and it writes a document instead of a reply. A card appears under the reply; open it and the document fills in beside the conversation, section by section. You can close the tab — it carries on. **Stop** keeps what is written; **Continue** picks up where it stopped.

To ask for one directly, use the report control in the composer, or type \`/report\` followed by what it should cover, e.g. \`/report write up the quarter for the board\`. \`/report\` alone asks what to cover.

**Where it lands.** A written document goes into a folder named after the agent, kept apart from the files you uploaded, so you can detach the agent's own writing without detaching your sources. It is an ordinary document: searchable in chat, downloadable, movable, included in the workspace export. From beside the conversation you can save it as **Markdown, Word or PDF**; any Markdown document can be downloaded as Word or PDF from its preview.

**Reading and editing existing documents.** An agent can list the documents in the folders it reads, read one in full, and edit it when you ask — fixing a section, updating figures, rewriting a paragraph. Edits to a text or Markdown document are made in place and the document is re-indexed so answers use the new version. For files that are not plain text, such as PDF or Word, the agent leaves the original untouched and saves an edited Markdown copy beside it. Editing needs a role that can change shared things; a viewer cannot write documents.

Each section of a written document costs about what a reply does, charged to the workspace's credits on the hosted service.`,

  routines: `# Routines

A routine runs an agent by itself: it reads what you point it at, does what the instructions say, and delivers the result. Find them under **Routines** in the sidebar or on an agent's **Routines** tab; create one with **New routine**. **Start from a sentence** fills in the form from a description like "Every Monday at 9, summarise last week's tickets for the team" — check the fields before saving.

**What starts it:**

- **On a schedule** — daily, weekly or any schedule, in the workspace's time zone (set in Settings → General).
- **On a webhook** — a URL you paste into another service or call yourself.
- **When an app event happens** — for example a new email in Gmail or Outlook, a calendar event, a GitHub push or issue, a Slack message, a Notion page or Drive file change, a new feed post or video, a reply to the routine's own email. Which events are offered depends on what is connected.
- **From a connected source** — when a synced Drive or Notion folder changes.

**What it does:** it runs with the agent's model, tools and knowledge, following the **Instructions**. A routine has nobody to ask, so anything that would need an approval is not done; the result says what it wanted to do instead. When nothing relevant happened it can skip sending.

**Where the result goes:** your **Inbox**, an **Email** address, a **Slack** channel, or a signed webhook. Delivery channels are added under Settings → Preferences. It can also file each result into a folder as a document.

**Before saving**, **Run a test** sends one run only to you, and the form shows an estimate of what a run costs on the hosted service.

A routine is private to its owner unless shared. If it keeps failing it pauses itself; Settings → Preferences chooses which of these you are emailed about.`,

  integrations: `# Integrations

Everything an agent can reach outside Covan is connected under **Settings → Integrations**. Which ones appear depends on how this Covan is set up; some may say **Not configured here**.

**Connected apps — about 1,500.** Gmail, Outlook, Google Calendar, HubSpot, GitHub, Linear and many more. Pick an app and **Connect**: you either sign in at the app or paste a key it gives you. Then on the agent's Configuration (Tools) choose which agents may use it. Agents find the right operation and run it. The first action in an app asks you first, and anything that changes data (sending mail, creating a record) asks every time — unless you chose **Always allow this** for that operation. A connection can be **Only you** or shared with the workspace.

**Sources that sync into Knowledge.** **Google Drive** (a folder) and **Notion** (a database) are copied into a folder and kept in sync — additions, edits and removals. **Sync now** forces it.

**Slack.** **Add to Slack** installs the app; then mention an agent in a channel or message it directly. Whoever asks is answered as themselves, and only if the agent is shared with them. Slack messages and reactions can also start routines.

**Databases and APIs.** Connect a Postgres database (read through a read-only function) so an agent can query it, or an HTTP API you hold a token for, limited to the methods you allow.

**Browser.** An agent can use a real browser to open pages, fill forms and work in sites without an API. It asks before each task in a thread; you can watch, and **Take over** when a site wants a code or sign-in. Saved sign-ins let it sign in by itself next time.

**Web search** is switched on per agent on its Configuration tab.

On the hosted service, connected-app calls and browser time are charged to the workspace's credits.`,

  team: `# Your team

A workspace holds the team's agents, folders and people. Open **Team** in the sidebar (also Settings → Members).

**Inviting.** **Invite member**, enter an email and a role. The invitee gets an email with a link and accepts by signing up or signing in with that address. If no email could be sent, **Copy invite text** gives you a message to pass on; **Resend** makes a fresh link. Links last seven days.

**Roles:**

- **Admin** (and the **Owner**) — everything a member can do, plus managing people, roles and invitations, the workspace name and default model, and seeing the workspace's overall usage.
- **Member** — uses agents and changes shared things: uploads and deletes documents, creates folders and agents.
- **Viewer** — can only use agents shared with them and read what the workspace shares.

Everyone's own threads, routines and delivery channels are theirs; no role reads another person's private threads.

**Sharing an agent.** **Share** on an agent chooses who can use it — **Only me**, **Specific people** or everyone in the workspace — at **Can use**, **Can edit** or **Full access**. Losing access hides the agent; it deletes nothing.

**Working together.** **Share with workspace** in a thread lets colleagues read and write in it. A **Brainstorm** thread is shared from the start, with an idea board anyone in it can edit. **Home** shows what each agent is doing, recent activity, and what needs you.

**Coverage** (Settings → Coverage, admins) shows how well answers were grounded, by agent — never by person or question. Anyone can leave their questions out under Settings → Preferences.

Deleted agents, folders and documents can be restored for 30 days. Leaving or removing a member removes their access at once.`,

  settings_and_billing: `# Settings, usage and billing

**Settings** is at the foot of the sidebar.

Workspace pages:

- **General** — workspace name and icon, time zone (routines are scheduled in it), default model tier for new agents, the weekly usage summary, and deleting the workspace (scheduled 14 days ahead, and can be called off).
- **Members** — the Team page.
- **Integrations** — connected apps, sources, Slack, databases and APIs.
- **Usage and billing** — credits and spend by agent (hosted service).
- **Coverage** — how answers were grounded (admins).
- **API keys** — keys for scripts and other services, plus webhooks.
- **Export and deletion** — **Request export** builds one zip of everything you can see in the workspace — agents, documents and their files, threads, routines — with what is needed to load it into a Covan you run yourself.

Your account: **Profile** (name, photo, bio), **Security** (email, password, two-factor authentication, signed-in sessions) and **Preferences** (theme, interface language, which emails you get, delivery channels for routines, leaving your questions out of the coverage report). Agents answer in whatever language you write, whatever the interface language. **Help** links to the documentation and **Send feedback**.

**Credits (hosted service only).** On covan.app each workspace has one balance of credits that every member spends from. Model replies, document search and uploads, dictation, connected-app calls, browser tasks and routine runs are charged in credits; each reply's cost depends on the model. The balance is shown in the app and on **Settings → Usage and billing**, which is also where credits are added. When it reaches zero, replies, routines and connected-app calls pause until credits are added. For current prices, point people to that page or the terms rather than quoting numbers.

**Self-hosted Covan has no credits.** It uses its operator's own model provider keys, and what it spends is between the operator and the provider.`,

  api: `# The API

Everything the interface does goes through one HTTP API, so a script or another service can do what you can.

**Getting a key:** Settings → **API keys** → **New key**. Name it, then copy the key — it is shown once. If you lose it, revoke it and make another. If API keys are missing from Settings, this deployment has not turned them on.

**What a key can do:** exactly what you can do, in the workspace it was made in, and nothing more — a viewer's key can read but not write. A key cannot manage keys, members or invitations, connect apps or sources, or use the browser; those need you signed in. When you leave the workspace, your keys stop working. Revoking a key also pauses routines and disables delivery channels it created.

**Making a request:** send the key as a bearer token. On the hosted service the base address is https://api.covan.app; a self-hosted install uses its own.

\`\`\`
curl https://api.covan.app/agents -H "Authorization: Bearer $COVAN_API_KEY"
\`\`\`

There are endpoints for agents, conversations (including streaming a reply), knowledge folders and documents, routines, the workspace and its people, usage, and connected services. A routine can also be started from outside with its own webhook URL, no key needed.

**Webhooks:** owners and admins can have the workspace POST events to an address of theirs under Settings → API keys → Webhooks — a shared thread finished, an agent needs someone, a shared routine failed, a file was added to a shared folder. Payloads carry ids and names, never message text.

The documentation (Settings → Help → Documentation) has the full list.`,
};

/** The guide for a topic, or the overview when the topic is not one of ours. */
export function guideFor(topic: unknown): string {
  return typeof topic === "string" && (GUIDE_TOPICS as readonly string[]).includes(topic)
    ? COVAN_GUIDE[topic as GuideTopic]
    : COVAN_GUIDE.overview;
}
