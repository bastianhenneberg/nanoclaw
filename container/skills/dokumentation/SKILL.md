---
name: dokumentation
description: Session Memory dokumentieren und Aufgaben verwalten
---

# /dokumentation - Session Dokumentation

Wenn dieser Skill aufgerufen wird, nutze das **AI Brain MCP** zur Dokumentation.

## 1. Projekt ermitteln

Ermittle das aktuelle Projekt anhand des Arbeitsverzeichnisses:
- `/home/bastian/Development/peppermint-manager` → `peppermint-manager`
- `/home/bastian/Development/peppermint-crm` → `peppermint-crm`
- Anderes Verzeichnis → Frage den User nach dem Projektnamen

## 2. Aktuellen Kontext abrufen

Rufe `mcp__ai-brain__get-context-tool` auf um den aktuellen Stand zu sehen:
- Bisherige Memories
- Offene Tasks
- Offene Bugs

## 3. Session dokumentieren

Erstelle eine **Memory** mit `mcp__ai-brain__add-memory-tool`:
- **type**: `note`
- **title**: `Session YYYY-MM-DD - [Kurzbeschreibung]`
- **content**: Zusammenfassung der Session mit:
  - Was wurde gemacht
  - Welche Änderungen wurden vorgenommen
  - Wichtige Erkenntnisse

## 4. Learnings speichern

Falls es wichtige technische Erkenntnisse gab, speichere sie separat:
- **type**: `learning`
- Für Workarounds, Best Practices, Fallstricke

## 5. Tasks verwalten

Nutze die Task-Tools:
- `mcp__ai-brain__list-tasks-tool` - Offene Tasks anzeigen
- `mcp__ai-brain__complete-task-tool` - Erledigte Tasks abhaken
- `mcp__ai-brain__create-task-tool` - Neue Tasks erstellen

## 6. Bugs prüfen

Falls Bugs behoben wurden:
- `mcp__ai-brain__list-bugs-tool` - Bugs anzeigen
- Bugs die gefixt wurden als `status: fixed` markieren (via update-bug falls vorhanden)

## 7. Zusammenfassung ausgeben

Zeige dem User eine kurze Zusammenfassung:
- Was wurde dokumentiert
- Welche Tasks sind noch offen
- Welche Bugs sind noch offen

---

**Hinweis:** Dieser Skill erstellt keine Commits. Nutze `/fertig` zum Commiten und Pushen.
