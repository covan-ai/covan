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

## Uploading

The order on the Knowledge tab is create a bundle, select it, drop files into it,
then flip the switch that attaches it to this agent. Selecting a bundle is what
turns the drop zone on, so the upload always knows where it is going.

The accepted extensions are `md`, `markdown`, `txt`, `csv`, `json` and `pdf`, up
to 10 MB each, and the [Quickstart](quickstart.md#give-it-something-to-read) has
the table. What is worth adding here is that the check reads the file **name**.
The server takes the characters after the last dot and looks them up in a fixed
set; it never inspects the bytes. Renaming a `.docx` to `.txt` therefore gets
past the gate, and what happens next is not a helpful error — the file is decoded
as UTF-8 like any text file, and the mojibake that comes out is chunked and
embedded as though it were prose. It will not match anything sensible, and it
will sit in the bundle looking indexed. There is no DOCX support to reach this
way; the conversion has to happen before the upload.

Something refused for its extension, its size or for being empty is refused
before anything is stored, so a rejected upload leaves nothing behind.

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

### PDFs, and the scan that indexes nothing

A PDF is searchable, but not because the server reads it. Its text extractor
returns an empty string for anything ending in `.pdf`, because pdf.js does not
run reliably on the Workers runtime. The browser does the work instead: when you
pick a PDF, the page loads a PDF parser, pulls the text out locally and posts it
as an extra form field alongside the file. The server prefers that field over its
own extraction, so what gets indexed is what your browser managed to read.

That is why the interesting case is a PDF with no text layer — a scan, or a page
of screenshots. The extraction returns nothing, and a failed extraction is
swallowed rather than surfaced, so nothing comes back either way. The upload then
succeeds: the file is stored, the row is written with an empty excerpt, chunking
an empty string produces no chunks, and the response is a normal success. The
document is listed, it downloads back byte-for-byte, and its name is put in front
of the model on every turn as a document the agent has. What no question can do
is retrieve a word of it, and the fallback skips it too, because that path only
considers documents whose stored text is non-empty. The only visible signal is
the **Not indexed** chip beside it, and pressing refresh reports `document has no
indexable text` rather than fixing anything. You will only see that chip while
the bundle is attached to the agent whose tab you are on, because the document
list on that tab is the agent's rather than the selected bundle's — a file in a
bundle this agent has not been given is not listed there at all. A scan has to be
put through OCR somewhere else and uploaded as text.

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

The document names that grounded a reply are written onto the message when it is
saved, deduplicated and kept in relevance order, and shown as chips beneath the
answer. Because they are stored rather than recomputed, they survive a reload and
they are what actually went into that specific turn — not a fresh search run
against whatever the bundles hold today.

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
fallback, so an unindexed document that does have text still contributes its
excerpt when nothing matches, and it is only an unindexed document with no text
at all that contributes nothing but its name. Does the question share vocabulary
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
