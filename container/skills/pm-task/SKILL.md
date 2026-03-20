---
name: pm-task
description: Aufgabe im Peppermint Manager erstellen. Fragt Projekt, Zuweisung, Priorität und Fälligkeit ab.
---

# /pm-task - Aufgabe im Peppermint Manager erstellen

Wenn dieser Skill aufgerufen wird, erstelle eine Aufgabe im Peppermint Manager über den MCP Server.

## Workflow

### 1. Aufgabe verstehen

Lies was der User als Argument oder im Kontext mitgegeben hat. Extrahiere daraus:
- **Titel** der Aufgabe
- **Beschreibung** (falls Details genannt wurden)

### 2. Fehlende Infos erfragen

Frage den User nach den folgenden Informationen, sofern sie nicht bereits aus dem Kontext hervorgehen:

1. **Projekt** - "In welchem Projekt?" (nutze `mcp__peppermint__list-projects-tool` um aktive Projekte zu zeigen, wenn der User unsicher ist)
2. **Zuweisen an** - "Wem zuweisen?" (nutze `mcp__peppermint__list-users-tool` bei Bedarf, oder "niemandem" als Option)
3. **Priorität** - "Welche Priorität?" (low / medium / high / important / urgent, Default: medium)
4. **Fälligkeitsdatum** - "Bis wann?" (YYYY-MM-DD Format, oder "kein Datum")

**Wichtig:** Stelle alle Fragen auf einmal in einer kompakten Liste, nicht einzeln nacheinander!

### 3. Aufgabe erstellen

Nutze `mcp__peppermint__create-task-tool` mit den gesammelten Daten.

### 4. Bestätigung

Zeige dem User eine kurze Bestätigung:
```
Aufgabe #ID "Titel" erstellt
Projekt: X | Priorität: Y | Fällig: Z
```

## Hinweise

- Der Peppermint MCP Server ist global konfiguriert und in allen Projekten verfügbar
- User-IDs bekommst du über `mcp__peppermint__list-users-tool`
- Projekt-IDs über `mcp__peppermint__list-projects-tool`
- Bastian Henneberg hat User-ID 2 im Live-System
- Wenn der User sagt "mir zuweisen" → assigned_to: 2
