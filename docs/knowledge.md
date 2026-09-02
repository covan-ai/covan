# Knowledge bundles

Everything an agent knows beyond its persona arrives through a bundle. This page
is about working with them: how to draw the line between one bundle and the next,
what actually happens to a file between the drop zone and a searchable chunk, and
how to read an answer — including the answers where the agent says it does not
know. [Core concepts](concepts.md#knowledge-bundle) defines the nouns; this page
assumes them and goes after the behaviour.

## Why documents are grouped rather than piled

A bundle belongs to the workspace, and it reaches an agent through a row in
`agent_bundles` rather than through a column on either side. Two consequences
follow, and between them they are the whole reason for the indirection.

The first is that attaching costs nothing and detaching destroys nothing. Handing
a bundle to a second agent copies no bytes, re-embeds no text and adds no chunks:
the same rows are now in scope for a second agent as well. Taking it back is that
one row deleted.

The second is that the bundle is the unit of what an agent can see. Retrieval
searches the chunks whose bundle is attached to the agent being asked, and
nothing else. So a bundle boundary is not filing — it is a decision about which
agent gets to read what. Group by subject, or by the audience an agent serves,
rather than by who uploaded the file or when. A bundle nobody has attached is
unreachable by every agent in the workspace, however much is in it; it is still
listed on every member's Knowledge tab, because it is retrieval that cannot see
it, not the workspace.

Both roles can create, edit and delete bundles. There is no owner who has to
approve it.

## What a document should look like

The accepted formats are listed further down, and they are the least interesting
half of the answer. A file that is accepted can still be a file no question ever
reaches, and the difference is not the extension.

Four things decide it, all of them consequences of how retrieval works rather
than house style:

**One subject per file.** A question matches a passage, and the passage arrives
with its neighbours. A single handbook covering pricing, onboarding and the
deployment runbook competes with itself: the pricing question pulls a chunk that
happens to sit between two unrelated ones. Six files beat one file six times the
size.

**Write the answer, not a pointer to it.** "See the Notion page" retrieves
perfectly and answers nothing. So does a heading with nothing under it. The
agent can only say what the text says.

**Use the words people ask in.** Matching is on meaning as the embedding model
represents it, so a document written entirely in internal shorthand and a
question written in plain English may not meet. This is what makes a glossary of
your own terms one of the highest-value files in a workspace.

**Say when it was true.** Nothing updates a document in place — a re-upload
makes a new one — so a date inside the text is the only version the agent can
read. The source chip under an answer carries the upload date and warns past
ninety days, which tells the reader the file is old but not what it was current
for.

Everything else is ordinary writing. Headings help, because they give the
chunker a natural boundary to cut on, and they cost nothing.

### Starting from nothing

A team that has not written any of this down yet has the harder version of the
problem, and it is the common one: the first agent is often made before the
first document exists.

The Knowledge tab carries six starter documents for exactly that — company
overview, product notes, FAQ, how we work, glossary, and a meeting-notes shape.
Each downloads as a Markdown file of headings with a bracketed prompt under
each, and the prompts are questions rather than instructions. Fill one in and
upload it back.

They download rather than being created in place, and that is deliberate: an
empty template inside a bundle is worse than no document at all. Retrieval would
match it, the agent would ground an answer in `[Two or three sentences]`, and
the source chip under that answer would report the file as read.

If you fill in only one, make it the FAQ. It is the file whose headings are
already phrased the way somebody will ask.

## Uploading

There are two ways in, and they differ only in where the file lands.

The order on the Knowledge tab is create a bundle, select it, drop files into it,
then flip the switch that attaches it to this agent. Selecting a bundle is what
turns the drop zone on, so the upload always knows where it is going.

The other way is the conversation itself: the paperclip in the composer, a file
dragged anywhere onto the chat pane, or one pasted from the clipboard. Nothing
asks which bundle, because at that moment nobody knows — whether a file was
worth keeping is something you learn from the answer it produces. So it goes to
a bundle of the agent's own, named `<Agent> — chat uploads` and created on the
first file dropped into that agent's chat, attached immediately so the next
question can reach it. It is an ordinary bundle: it appears on the Knowledge
tab, it can be attached to other agents, and deleting it works like deleting any
other. Under the composer each file leaves a receipt saying what it became: its
name, whether it is indexed, and which bundle it is in. The bundle name on the
receipt is a menu — pick another and the document moves there, which is the
answer to "this turned out to be worth keeping" arriving at the only moment
anyone can give it, after the reply. The × deletes the document instead, for the
file that was only ever meant to be glanced at.

A move takes the document's chunks with it, which matters more than it sounds:
retrieval reads scope from the chunks rather than from the document row, so a
move that left them behind would look correct until the chat bundle was detached
and the passages quietly stopped being findable. It needs the update policy added
in migration 0024; against a database without it the move is refused rather than
half-done.

The accepted extensions are `md`, `markdown`, `txt`, `csv`, `json` and `pdf`, up
to 10 MB each, and the [Quickstart](quickstart.md#give-it-something-to-read) has
the table. The extension check reads the file **name** — the characters after
the last dot, looked up in a fixed set, with the bytes never inspected. Renaming
a `.docx` to `.txt` therefore gets past that gate, and is then caught by the
next one: the text is extracted before anything is stored, and a file with no
readable text in it is refused. What a zip container decodes to is not text —
NUL bytes throughout and replacement characters everywhere else — so the upload
comes back saying the file is not the format its name claims. There is no DOCX
support to reach this way; the conversion has to happen before the upload.

The same gate is deliberately loose about a file that is merely mangled. A
Turkish `.txt` saved as Windows-1254 and read as UTF-8 loses its accented
letters to replacement characters and keeps every other word, which is worth
indexing; the line is drawn at 30% of the text, well above what a legacy
encoding costs and well below what a binary produces.

Something refused for its extension, its size, for being empty or for having no
readable text is refused before anything is stored, so a rejected upload leaves
nothing behind.

An accepted one leaves three things: the bytes in the document store, a row
carrying the name, the size, the storage key and an excerpt of the extracted text
— the first 8000 characters — and, if embedding succeeds, one row per chunk with
its vector. Chunking is not a blind slice. Each chunk runs to at most 1000
characters and ends at the strongest natural boundary available in the back half
of that window: a paragraph break if there is one, then a sentence end, then a
line end, then a word end, falling back to a hard cut only for text with no
boundary at all. Consecutive chunks share roughly 150 characters, snapped back to
a whole word, so a sentence that straddles a boundary is still findable from
either side. The mechanism is in [retrieval](architecture.md#retrieval).

Note the asymmetry between the excerpt and the chunks, because it decides what
can be found later: the chunks are cut from the **whole** text, however long,
while the excerpt stops at 8000 characters. A long document is searchable to its
end, but only its opening is available to the fallback described below.

### PDFs, and the scan that is refused

A PDF is searchable, but not because the server reads it. Its text extractor
returns an empty string for anything ending in `.pdf`, because pdf.js does not
run reliably on the Workers runtime. The browser does the work instead: when you
pick a PDF, the page loads a PDF parser, pulls the text out locally and posts it
as an extra form field alongside the file. The server prefers that field over its
own extraction, so what gets indexed is what your browser managed to read.

That is why the interesting case is a PDF with no text layer — a scan, or a page
of screenshots. The browser's parser returns nothing, there is no server-side
extraction to fall back on, and the upload is refused with a sentence saying so.
It used to succeed, which was worse in a way that took a while to see: the file
was stored, the row written with an empty excerpt, and the document listed and
downloadable and named to the model on every turn as something the agent has,
while no question could retrieve a word of it. A scan has to be put through OCR
somewhere else and uploaded as text.

### Reindexing

The refresh control beside a document re-extracts, re-chunks and re-embeds it,
replacing its chunks. It exists for the document whose upload-time embedding
failed — indexing is best-effort, and a failure there leaves a file that no
passage can ever be matched in, reachable only through the fallback described
further down — and for picking up a change to how chunks are cut.

It behaves differently on a PDF, for the same reason uploads do. For a text
format it re-reads the original bytes from the store, so it works from the
complete document. For a PDF the server still cannot parse the bytes, and the
browser is not involved this time, so it falls back to the stored excerpt. A PDF
longer than 8000 characters therefore comes back from a reindex with a narrower
index than it had after upload. Reindex a PDF when it retrieves nothing at all;
re-uploading it is the way to rebuild a full index.

## Attaching, detaching and deleting

The switch beside each bundle attaches it to the agent whose tab you are on.
Bundles and agents must belong to the same workspace for the attachment to be
accepted — the database checks that, not the interface.

Detaching removes the attachment and nothing else. The documents, the chunks and
the bundle itself all survive, and re-attaching restores exactly what was there.
Deleting is the destructive one: removing a bundle takes its documents, their
chunks and every agent's attachment to it with it, and the interface asks first
for that reason. Deleting a single document removes its chunks with it, and makes
a best-effort attempt on the stored bytes.

## What happens when somebody asks a question

Each turn starts by embedding the message that was just sent, with the same model
the chunks were embedded with, and asking the database for the six nearest chunks
across the attached bundles whose cosine similarity is at or above 0.25.

The floor is what makes a wrong answer less likely than a coy one. Vector search
always returns something — ask an agent that only knows the deployment runbook
about somebody's holiday plans and there is still a nearest chunk. Without a
floor those six chunks are handed to the model inside a block that says the team
has shared this knowledge, which is a claim about relevance that nobody checked.
The floor drops them instead. `text-embedding-3-small` puts genuinely on-topic
content well above 0.25 and clearly unrelated content below it, so the effect in
practice is to remove noise rather than to starve real matches.

0.25 is therefore a fact about that model, not about retrieval, and a
self-hosted Covan that embeds with something else needs its own — which is what
`RAG_MIN_SIMILARITY` is for. It is worth setting deliberately: a floor that is
wrong for the model in use produces no error at all, only answers that are
vaguer or emptier than they should be.

What survives is assembled in similarity order under a 4000-character budget and
sent as its own system message, positioned after the earlier turns and just
before the latest one. Two details of that block matter when you read a reply.
The budget is spent in order, so the last chunk admitted can be cut off partway
through, and anything after the budget runs out is dropped. And the block
explicitly tells the model not to quote or name the files, because the interface
shows the sources itself — so an answer that never mentions a filename is
behaving correctly, not hiding its working.

Separately, and further up, the agent's system prefix carries a manifest listing
the names of every document in the attached bundles. That is there so an agent
cannot deny having files it plainly has. It is names only, so the manifest tells
the model what exists without telling it what any of it says.

### When nothing clears the floor

It is worth being exact about this, because it is easy to assume the floor alone
produces "I don't know". It does not, on its own.

If no chunk clears the floor and the agent has documents, the reply is grounded
on those documents' stored excerpts instead, newest first, under the same
4000-character budget. That escape hatch exists for questions like "summarise the
file", which embed close to nothing in particular and would otherwise get an
agent insisting it cannot read a document it is holding. So an agent answers from
its persona alone only when it genuinely has nothing: no attached bundles, or
nothing in them with any extractable text.

The honest reading of an answer is therefore that the floor governs what is
presented as a matched passage, and the fallback governs what is available when
nothing matched. The model can still say it does not know, and with excerpts of
unrelated documents in front of it that is the right answer — but it is the model
declining, not the retrieval layer having withheld everything.

Retrieval is best-effort throughout. If embedding the question or the search
itself fails, the turn quietly falls back to a persona-only answer rather than
failing.

### Sources

The documents that grounded a reply are written onto the message when it is
saved — by id and by name, deduplicated and kept in relevance order — and shown
as chips beneath the answer. Because they are stored rather than recomputed,
they survive a reload and they are what actually went into that specific turn,
not a fresh search run against whatever the bundles hold today.

Each chip also carries the document's age, and warns past ninety days. That is
there because retrieval working correctly is the whole problem: a process
document written in January is still the best match for a January question in
September, and the agent will quote it with the same confidence it quotes
anything. The chip made the answer checkable and said which file; it could not
say that the file is nine months old. An onboarding document written once and
wrong a quarter later is exactly what teams upload first and exactly what nobody
remembers to revisit.

The age is the upload date, and for a document that is the whole of freshness:
nothing updates one in place. A re-upload creates a new document, and
**Reindex** re-embeds the same stored text. So there is no "last edited" to
want — the January file is the January file.

A chip with no date is not a fault. Replies written before ids were stored cite
by name alone, and a name cannot be resolved back to a document without
guessing; the same is true of a document that has since been deleted. Both keep
their citation and say nothing about age, which is the honest half of the
answer.

Read them as what was in scope, not as what the model saw, because the two are
not the same list. The names are collected from every match — and on the fallback
path from every document that had any text — before the 4000-character budget is
applied, and the budget is easy to overrun: six chunks of up to 1000 characters
each go past it, and on the fallback path a single 8000-character excerpt fills
it twice over on its own, leaving every document listed after it contributing
nothing at all. Those documents are still named underneath the answer.

So a chip says a document was searched and admitted, not that a word of it
reached the model. That matters most in exactly the case you would use it — a
long answer with four sources under it, where the fourth may have been cut before
the model ever saw it.

## When an answer is not what you expected

Work down the path the question takes. Is the bundle attached to this agent —
retrieval sees nothing else, and a bundle can look full and still be out of
scope. Is the document **Indexed** — the chip is the difference between a file
whose passages can be matched and one whose text is reachable only through the
fallback, so an unindexed document still contributes its excerpt when nothing
matches. Since uploads with no readable text are now refused, a document that
reached the bundle has text in it, and an **Indexed** chip that never appeared
means the embedding failed rather than that there was nothing to embed — which
is what the refresh control is for. Documents uploaded before that refusal
existed are the exception, and they are the ones that contribute nothing but
their name. Does the question share vocabulary
with the document, since matching is on meaning as the embedding model represents
it, and a question phrased entirely in your own words about a passage phrased
entirely in someone else's may not clear the floor. And if the reply reads like a
summary of the tops of several documents rather than an answer, that is the
fallback, which means nothing matched.

## Where to go next

- [Core concepts](concepts.md) — the precise definitions behind the words used
  here, and how bundles sit against workspaces, agents and sessions.
- [Retrieval, in detail](architecture.md#retrieval) — the same path from the
  inside: the upload steps, the SQL the floor lives in, and why the prompt is
  assembled in the order it is.
- [Quickstart](quickstart.md) — the shorter route through the same ground, from
  an empty account to an answer with its sources attached.
