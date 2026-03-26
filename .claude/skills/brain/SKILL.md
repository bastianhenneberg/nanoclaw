---
name: brain
description: AI Brain - Zentrales Wissensmanagement für alle Projekte. Dokumentiere Entscheidungen, Tasks, Learnings und hole Projektkontext.
---

# AI Brain Skill

Zentrales Second Brain für alle Projekte via MCP `mcp__ai-brain__<tool>`.

## Projektkontext

```
# Projekte auflisten
mcp__ai-brain__list-projects-tool()

# Kontext holen (am Anfang jeder Session!)
mcp__ai-brain__get-context-tool(project="<slug>")

# Memories suchen
mcp__ai-brain__search-memories-tool(query="...", project="<slug>")
```

## Memories (Wissen dokumentieren)

```
mcp__ai-brain__add-memory-tool(project="<slug>", type="decision", title="...", content="...")
```

**Types:** `decision`, `learning`, `issue`, `solution`, `todo`, `note`

## Tasks

```
# Erstellen
mcp__ai-brain__create-task-tool(project="<slug>", title="...", description="...")

# Auflisten
mcp__ai-brain__list-tasks-tool(project="<slug>")

# Updaten
mcp__ai-brain__update-task-tool(id=123, status="done")

# Abschließen
mcp__ai-brain__complete-task-tool(id=123)
```

## Bugs

```
# Erstellen
mcp__ai-brain__create-bug-tool(project="<slug>", title="...", description="...")

# Auflisten
mcp__ai-brain__list-bugs-tool(project="<slug>")

# Updaten (mit Lösung)
mcp__ai-brain__update-bug-tool(id=123, status="fixed", solution="...")
```

## Ideas (Backlog)

```
mcp__ai-brain__create-idea-tool(project="<slug>", title="...", category="feature")
mcp__ai-brain__list-ideas-tool(project="<slug>")
mcp__ai-brain__update-idea-tool(id=123, status="planned")
```

## Time Tracking ⏱️

```
# Timer starten
mcp__ai-brain__start-timer-tool(project="<slug>", description="Feature X implementieren")

# Timer stoppen (letzten oder alle)
mcp__ai-brain__stop-timer-tool()
mcp__ai-brain__stop-timer-tool(project="all")

# Zeiteinträge auflisten
mcp__ai-brain__list-time-entries-tool(project="<slug>")

# Manueller Eintrag (nachträglich)
mcp__ai-brain__create-time-entry-tool(project="<slug>", description="...", duration_minutes=90)
```

## Wiki

```
# Artikel erstellen
mcp__ai-brain__add-wiki-tool(title="...", content="...", project="<slug>")

# Suchen
mcp__ai-brain__search-wiki-tool(query="...")

# Auflisten
mcp__ai-brain__list-wiki-tool(project="<slug>")
```

## Secrets & Credentials

```
# Secret speichern/holen
mcp__ai-brain__set-secret-tool(project="<slug>", key="API_KEY", value="...")
mcp__ai-brain__get-secret-tool(project="<slug>", key="API_KEY")

# Zugangsdaten
mcp__ai-brain__set-credential-tool(project="<slug>", name="Production DB", type="db", host="...", username="...", password="...")
mcp__ai-brain__get-credential-tool(project="<slug>", name="Production DB")
```

## Obsidian Notes (Vault)

```
mcp__ai-brain__list-notes-tool(path="topics/arbeit")
mcp__ai-brain__read-note-tool(path="topics/arbeit/server.md")
mcp__ai-brain__write-note-tool(path="...", content="...")
mcp__ai-brain__search-notes-tool(query="...")
```

## Workflow

1. **Session-Start:** `get-context-tool` aufrufen
2. **Entscheidungen:** `add-memory-tool` mit type="decision"
3. **Bugs gefunden:** `create-bug-tool`
4. **Zeit tracken:** `start-timer-tool` → arbeiten → `stop-timer-tool`
5. **Fertig:** `complete-task-tool`
