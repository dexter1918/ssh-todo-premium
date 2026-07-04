# Prompt

Build a **premium desktop-first To-Do and Notes web application** using only **HTML, CSS and Vanilla JavaScript**.

Do not use React, Angular, Vue, jQuery, Bootstrap, Tailwind or any third-party framework.

The application must feel like a native desktop productivity application comparable to Apple Notes, Microsoft To Do, Any.do, TickTick and Notion.

The application should be designed primarily for **large desktop screens (1920x1080 and above)** while remaining usable on tablets and mobile devices.

---

# Technical Requirements

* Pure HTML5, CSS3 and Vanilla JavaScript (ES6+).
* No backend.
* Store everything in LocalStorage.
* Auto-save all data instantly.
* Organize code cleanly and modularly.
* Separate files:

  * `index.html`
  * `styles.css`
  * `app.js`
* Must work completely offline.
* No external dependencies.

---

# Overall Layout

Create a modern **three-pane desktop layout**.

## Left Sidebar (300px width)

Permanent sidebar.

Contains:

* Application logo.
* User profile section.
* Global search bar.
* Smart Lists section.
* Custom Lists section.
* Folder management.
* Tags section.
* Productivity summary.
* Settings button.

Sidebar should support:

* Collapse/Expand.
* Resizable width.
* Smooth collapse animations.

---

## Middle Pane (450px width)

Primary task navigation panel.

Contains:

* Current list title.
* Toolbar.
* Task creation bar.
* Filters.
* Sort controls.
* Bulk actions.
* Task list.

Task list must support:

* Infinite scrolling.
* Virtual rendering.
* Drag-and-drop ordering.
* Multi-selection.
* Grouping.

---

## Right Pane (Remaining Width)

Task details and notes editor.

Displays:

* Task title.
* Metadata.
* Rich notes editor.
* Subtasks.
* Attachments.
* Activity timeline.
* Reminder settings.
* Comments section.

This panel should update live when a task is selected.

---

# Design Language

Create a premium desktop UI inspired by:

* Apple Notes
* Microsoft To Do
* Notion
* Linear
* Arc Browser

Style:

* Modern glassmorphism.
* Frosted sidebars.
* Soft shadows.
* Large rounded corners.
* Premium typography.
* Spacious layout.
* Subtle gradients.
* Elegant color palette.

The application should look like enterprise-grade SaaS software.

---

# Theme System

Implement:

## Light Theme

Default.

## Dark Theme

Professional dark workspace.

## System Theme

Automatically follow OS preference.

Theme transitions should animate smoothly.

Allow custom accent colors.

---

# Smart Lists

Provide built-in lists:

* All Tasks
* Today
* Tomorrow
* Upcoming
* Important
* Starred
* Scheduled
* Completed
* Overdue
* Notes
* Archived
* Trash

All lists update dynamically.

---

# Folder Features

Support:

* Unlimited folders.
* Nested folders.
* Folder colors.
* Folder icons.
* Drag reordering.
* Rename.
* Archive.
* Delete.

---

# Task Features

Every task should support:

* Title.
* Description.
* Rich note body.
* Checklist.
* Subtasks.
* Priority.
* Tags.
* Folder assignment.
* Due date.
* Due time.
* Reminder.
* Repeat rule.
* Starred.
* Pinned.
* Completed.
* Archived.
* Progress.
* Creation date.
* Last modified date.

---

# Rich Note Editor

Create a rich editor similar to Apple Notes.

Support:

* Headings.
* Bold.
* Italic.
* Underline.
* Strikethrough.
* Bullet lists.
* Numbered lists.
* Checklists.
* Code blocks.
* Quotes.
* Horizontal separators.
* Inline code.
* Hyperlinks.

Use `contenteditable`.

Auto-save continuously.

---

# Task List Features

Each task card should display:

* Checkbox.
* Title.
* Preview text.
* Due date.
* Priority indicator.
* Tags.
* Reminder icon.
* Subtask progress.
* Completion percentage.

Support:

* Swipe actions on trackpad.
* Right-click context menu.
* Inline editing.
* Drag and drop.
* Bulk selection.

---

# Search System

Implement global search.

Features:

* Instant search.
* Fuzzy matching.
* Highlight matches.
* Search notes.
* Search subtasks.
* Search tags.
* Search folders.

Search results should appear instantly.

---

# Filtering

Allow filtering by:

* Priority.
* Date.
* Folder.
* Tag.
* Status.
* Completion.
* Reminder.
* Starred.

Allow combining filters.

---

# Sorting

Support:

* Manual.
* Due date.
* Priority.
* Creation date.
* Updated date.
* Alphabetical.

Ascending and descending.

---

# Views

Implement multiple desktop views.

## List View

Default.

## Kanban View

Columns:

* To Do
* In Progress
* Waiting
* Completed

Drag cards between columns.

## Calendar View

Monthly calendar.

Display scheduled tasks.

## Timeline View

Horizontal timeline.

## Dashboard View

Analytics screen.

---

# Productivity Dashboard

Display:

* Total tasks.
* Pending tasks.
* Completed tasks.
* Weekly productivity.
* Monthly productivity.
* Streak count.
* Completion rate.
* Overdue tasks.

Create animated charts using Canvas API.

---

# Notifications

Support browser notifications for:

* Reminders.
* Due tasks.
* Daily summary.

---

# Keyboard Shortcuts

Desktop productivity apps depend heavily on shortcuts.

Implement:

| Shortcut | Action          |
| -------- | --------------- |
| Ctrl + N | New Task        |
| Ctrl + F | Search          |
| Ctrl + K | Command Palette |
| Ctrl + D | Duplicate       |
| Ctrl + Z | Undo            |
| Ctrl + Y | Redo            |
| Delete   | Delete Task     |
| Space    | Complete Task   |
| Esc      | Close dialogs   |

Provide a shortcut cheat sheet.

---

# Command Palette

Create a Notion-style command palette.

Open using:

`Ctrl + K`

Actions:

* Create task.
* Search.
* Switch folder.
* Change theme.
* Filter tasks.
* Open settings.

---

# Required Animations

Use premium desktop animations.

Implement:

### Window-like animations

* Fade.
* Scale.
* Blur.

### Task animations

* Insert animation.
* Delete collapse.
* Completion animation.
* Hover elevation.
* Drag lift effect.

### Sidebar animations

* Expand.
* Collapse.
* Resize.

### Panel animations

* Smooth content switching.
* Sliding transitions.

### Micro-interactions

* Ripple clicks.
* Button hover states.
* Checkbox animations.
* Staggered task loading.
* Toast notifications.

All animations must remain smooth at 60 FPS.

---

# Context Menus

Implement custom right-click menus.

Examples:

* Rename.
* Duplicate.
* Archive.
* Move.
* Delete.
* Add tag.
* Pin.

---

# Accessibility

Support:

* Full keyboard navigation.
* ARIA labels.
* Screen readers.
* Visible focus states.

---

# Performance

Optimize for 10,000+ tasks.

Requirements:

* Event delegation.
* Debounced search.
* Virtual scrolling.
* Efficient LocalStorage updates.
* Minimal DOM re-rendering.

---

# Final Goal

The finished application should feel indistinguishable from a modern premium desktop productivity application and should be polished enough to showcase as a professional portfolio project or commercial SaaS prototype.
