# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One user: the owner. They check the dashboard many times a day, mostly on the
phone (installed as an app) and also on the laptop, to see what needs them
across all their projects, and to open those
projects' apps.

## Product Purpose

A private overview of everything the owner runs. In order of use:

- **What is waiting on me:** owner tasks, projects that are blocked or need
  attention, and decisions to make, each linking to its issue.
- **Health of all projects:** versions, open and closed issues, builds,
  activity and next steps, at a glance.
- **Launcher:** the Desktop opens each project's app the way its users see it.
- **Costs and storage:** GitHub Actions minutes, billing, and storage use
  against their limits.

Success means the owner learns what needs them within seconds of opening it,
and nothing that needs them goes unnoticed.

## Positioning

It is fed by the projects' own Claude Code sessions: each writes a status file
in a fixed schema (STATUS_INSTRUCTIONS.md), and laptop timers add usage,
storage and activity. The page shows that data, not a generic project tracker.

## Operating Context

- Status files arrive in D1 within a minute of a session writing them. The
  page is rendered by a Cloudflare Worker on each request and shows an
  "Update" notice when its data or code changes.
- Views: Desktop (first page), Overview, Projects, Activity, Builds, Storage,
  and a page per project. On wide screens a project can be pinned to the left.
- Used alongside GitHub (issues and PRs), Cloudflare, and Claude Code.

## Capabilities and Constraints

- Framework-free: plain HTML, CSS and JavaScript rendered by the Worker,
  minimal dependencies (only wrangler). Keep it that way.
- Phone-first: it must work best on a phone (bottom tab bar, installed PWA),
  and also at desktop widths, in light and dark.
- Right-to-left: content and UI must handle RTL text such as Persian,
  including RTL and English on one line.
- Private only: always behind Cloudflare Access; never public, no
  workers.dev or preview URL.
- The page makes no API calls of its own; all external data is collected on
  the laptop.
- The status schema lives only in STATUS_INSTRUCTIONS.md.

## Evidence on Hand

Real data only: the projects' status files, usage and storage numbers.
Screenshots for issues and PRs use demo data, never real issue titles.

## Product Principles

1. What needs the owner comes first and is never hidden.
2. Glanceable on a phone: dense, scannable, no decoration that slows reading.
3. Show real data honestly: unknown values are hidden, never invented; a
   broken status file shows as a warning, never breaks the page.
4. Private by construction.
