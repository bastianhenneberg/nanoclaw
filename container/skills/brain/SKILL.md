---
name: brain
description: AI Brain Session-Workflow — Kontext laden, Tasks planen, Timer tracken, Session dokumentieren. Starte jede Coding-Session mit /brain.
---

# /brain — AI Brain Session-Workflow

Du MUSST diesen Workflow vollständig einhalten. Keine Ausnahmen.

Den Projekt-Slug findest du in der CLAUDE.md des aktuellen Projekts unter `## AI Brain`.

---

## Phase 1: Kontext & Planung

BEVOR du Code anfasst oder Änderungen machst:

1. **Kontext laden:**
   `mcp__ai-brain__get-context-tool(project: "<slug>")`

2. **Wissen prüfen** — Wurde das Problem schon gelöst?
   `mcp__ai-brain__search-memories-tool(query: "...", project: "all")`
   `mcp__ai-brain__search-wiki-tool(query: "...")`

3. **Aufgabe analysieren** — Verstehe was der User will. Stelle Rückfragen falls unklar.

4. **Tasks anlegen** — Zerlege die Aufgabe in Arbeitsschritte:
   `mcp__ai-brain__create-task-tool(project: "<slug>", title: "...", priority: "high|medium|low")`

5. **Plan vorstellen** — Präsentiere die Tasks und warte auf Bestätigung.
   **STOPP: Erst nach expliziter Freigabe weiterarbeiten!**

---

## Phase 2: Umsetzung (pro Task wiederholen)

6. **Timer starten** — BEVOR du am Task arbeitest:
   `mcp__ai-brain__start-timer-tool(project: "<slug>", description: "Task-Beschreibung")`

7. **Task umsetzen** — Code schreiben, Tests schreiben, Änderungen vornehmen.

8. **Ergebnis vorstellen** — Zeige was du gemacht hast.
   **STOPP: Warte auf Feedback. Gehe NICHT eigenständig zum nächsten Task!**

9. **Feedback einarbeiten** — Änderungen nach User-Wunsch.

10. **Task abschließen & Timer stoppen:**
    `mcp__ai-brain__complete-task-tool(id: <task-id>)`
    `mcp__ai-brain__stop-timer-tool(notes: "Was erreicht wurde")`

Zurück zu Schritt 6 für den nächsten Task.

---

## Phase 3: Session-Abschluss

Nachdem alle Tasks erledigt sind:

11. **Session dokumentieren:**
    `mcp__ai-brain__add-memory-tool(project: "<slug>", type: "note", title: "Session YYYY-MM-DD — Kurztitel", content: "Zusammenfassung")`

---

## Dokumentation (laufend, bei Bedarf)

| Situation | Tool |
|-----------|------|
| Etwas Neues gelernt | `mcp__ai-brain__add-memory-tool(type: "learning", ...)` |
| Architektur-Entscheidung | `mcp__ai-brain__add-memory-tool(type: "decision", ...)` |
| Bug entdeckt | `mcp__ai-brain__create-bug-tool(...)` |
| Bug behoben | `mcp__ai-brain__update-bug-tool(id, status: "fixed", solution: "...")` |
| Projektübergreifend nützlich | `mcp__ai-brain__add-wiki-tool(...)` |
