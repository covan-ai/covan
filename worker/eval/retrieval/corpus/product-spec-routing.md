# Product spec: Smart Routing (PRD-RT-0007)

Owner: Deniz Arslan (Product). Engineering lead: Cem Özdemir. Status: beta, last updated 2026-09-12. This document specifies the Smart Routing feature of Pervane Rota, which automatically assigns stops to vehicles and orders them into routes.

## 1. Background and goals

Dispatchers at customers of Pervane Rota plan between 40 and 600 delivery or service stops per day. Today they drag stops onto vehicles by hand, which takes 35 to 90 minutes per day and produces plans that are on average 11% longer than the best plan we can find offline. Smart Routing aims to produce a good plan in under 90 seconds and let the dispatcher adjust it.

Goals: reduce planning time by at least 60%; reduce total drive time by at least 8% against the manual plan on the same input; never silently drop a stop; keep a human in control of the final plan.

Non-goals for the beta: multi-depot routing, real-time re-routing during the day, driver preference learning, electric vehicle charging constraints.

## 2. Definitions

Stop: a location visited once, with an optional time window, service duration and load. Vehicle: a resource with a start depot, an end depot, capacity and a shift window. Route: the ordered list of stops assigned to one vehicle. Plan: the set of routes for one planning day. Unassigned stop: a stop that no route could take without breaking a hard constraint.

## 3. Functional requirements

REQ-01 The dispatcher can start the solver from the daily planning screen with the "Optimise" button.
REQ-02 The solver accepts up to 300 stops and 60 vehicles in the beta.
REQ-03 If the input exceeds 300 stops, the system shows the message "This plan is too large for Smart Routing in beta" and keeps the manual planner available.
REQ-04 Each stop may have one time window; a time window has an earliest and latest arrival time, in the depot's time zone.
REQ-05 Time windows are hard constraints by default; the dispatcher can mark a stop "soft", which adds a lateness penalty of 1.0 per minute.
REQ-06 Vehicle capacity is a single integer in the customer's chosen unit (parcels, kilograms or pallets).
REQ-07 The solver must return a first feasible plan within 20 seconds and keep improving until the time budget of 90 seconds is used or no improvement is found for 15 seconds.
REQ-08 The planning screen shows the progress of the solver with the best total drive time found so far.
REQ-09 The dispatcher can cancel a running solve; cancelling keeps the best plan found so far.
REQ-10 Every plan stores the solver version, input hash and run time.
REQ-11 The dispatcher can lock a stop to a vehicle; the solver may reorder locked stops within a route but must not move them to another vehicle.
REQ-12 The dispatcher can lock the first stop of a route.
REQ-13 Travel times come from the road network matrix, refreshed every 15 minutes with typical traffic for the planned departure hour.
REQ-14 Driving speeds are never assumed; if the matrix service is unreachable the solve fails with an error and does not fall back to straight-line distance.
REQ-15 Service duration defaults to 6 minutes per stop and can be overridden per stop and per customer.
REQ-16 Breaks: a vehicle may have one mandatory break of 30 to 60 minutes inside a window; the solver must place it between two stops.
REQ-17 A stop that cannot be assigned must appear in the "Unassigned" panel with the reason (time window, capacity, shift length or unreachable).
REQ-18 Unassigned stops are never deleted; the dispatcher can drag them into a route manually, which shows a warning when it breaks a constraint.
REQ-19 Solver runs are limited to 40 per workspace per day; the 41st attempt shows the limit and the time it resets (midnight in the workspace's time zone).
REQ-20 The solver runs on a queue; when more than 6 solves are waiting, the dispatcher sees an estimated wait.
REQ-21 The result view lists, per route, total distance, total drive time, idle time, stops, load factor and the time the vehicle returns to its depot.
REQ-22 The dispatcher can compare the new plan with the previous manual plan: total drive time, number of late stops, number of unassigned stops.
REQ-23 Accepting a plan is explicit; until accepted, the previous plan stays in force and drivers see no change.
REQ-24 Accepting a plan notifies affected drivers through the mobile app within 60 seconds.
REQ-25 If a driver has already started a route, the solver may not change the stops already completed.
REQ-26 The audit log records who ran the solver, who accepted the plan and which input changes happened between.
REQ-27 Workspace administrators can disable Smart Routing for the whole workspace.
REQ-28 All solver inputs and outputs are stored in the workspace's region and encrypted at rest.
REQ-29 The API exposes POST /v2/plans/{id}/optimise with the same limits as the UI.
REQ-30 The API returns 429 with a Retry-After header when the daily limit in REQ-19 is reached.
REQ-31 (Q4, not in beta) Multi-depot routing: vehicles may start and end at different depots and stops may be served from any depot.

## 4. Non-functional requirements

Performance: p95 solve time at 300 stops and 60 vehicles must be at most 90 seconds. At 100 stops it must be at most 25 seconds. Memory per solve must not exceed 1.5 GB.

Reliability: a failed solve must not corrupt the current plan. A solver crash is retried once; after the second failure the dispatcher sees the message "The optimiser could not finish. Your plan has not been changed." and the incident is logged with code RT-5xx.

Security: the solver worker has no network access except to the matrix service and the plan database. Customer coordinates are not logged in plaintext.

Accessibility: all progress and results are available to screen readers; the map is not the only way to see a plan.

## 5. Edge cases

EC-01 Two stops at the same coordinates with different time windows: treated as separate stops; the solver may serve them consecutively with zero travel time.
EC-02 A stop whose time window closes before any vehicle's shift starts: goes to Unassigned with reason "time window".
EC-03 A stop heavier than the largest vehicle capacity: Unassigned with reason "capacity".
EC-04 A depot with no vehicles: the solve returns an error before starting.
EC-05 A vehicle with a shift of less than 2 hours: allowed, but the planning screen shows a warning.
EC-06 Daylight-saving transitions: Türkiye does not use daylight saving, but customers with depots in other time zones must have the transition handled; times are stored in UTC with the depot zone.
EC-07 A dispatcher edits the plan while a solve is running: the edit is allowed, and the solver result, when finished, is shown as a separate proposal rather than overwriting the edit.
EC-08 A stop's address cannot be geocoded: the stop is rejected at import with a row-level error, not at solve time.
EC-09 Negative service durations or time windows where the latest time is earlier than the earliest: import rejects the row.
EC-10 A 300-stop plan with a single vehicle: the solver returns the best feasible subset and puts the rest in Unassigned; it never returns a route that exceeds the shift window.
EC-11 Two simultaneous solves for the same plan: the second request is rejected with HTTP 409.
EC-12 A customer that has reached the REQ-19 daily limit of 40 solves may still cancel and accept plans.

## 6. Metrics

We will measure, for each design partner: planning time (self-reported weekly), drive time saved against their manual plan, number of solves per day, number of plans accepted, share of accepted plans edited after acceptance. Targets for exit: median planning time under 20 minutes, median drive time saving at least 8%, at least 70% of solves accepted.

## 7. Rollout

Beta started 15 September 2026 for five design partners. The feature flag is "smart_routing_beta" and is set per workspace. General availability is not before 3 November 2026. The pricing proposal is an add-on of 480 USD per month, to be confirmed by the pricing review. Documentation: a help-centre article and a 6-minute walkthrough video, prepared by Rabia Şen.

## 8. Open questions

OQ-1 Should soft time windows be exposed to dispatchers in the beta or kept as an API-only option? Decision by 30 September.
OQ-2 Do we need a dedicated "reoptimise from now" mode for mid-day changes? Design partners asked for it twice; parked for Q4.
OQ-3 What is the right default for the penalty in REQ-05? Currently 1.0 per minute; Gizem's tests suggest 0.5 produces fewer late stops with a small drive-time cost.

## 9. Appendix: error codes

RT-501 Matrix service unreachable. RT-502 Input validation failed after import. RT-503 Solver exceeded memory limit of 1.5 GB. RT-504 Solver exceeded the 90-second time budget without a feasible plan. RT-505 Daily limit reached. RT-510 Internal error, retried once.

## 10. Appendix: sample timings from the July prototype

At 50 stops the prototype returned a feasible plan in 3 seconds and the best plan after 14 seconds. At 150 stops the first plan came after 9 seconds and the best after 41. At 300 stops the first feasible plan took 19 seconds and the best came after 128 seconds, before the queue tuning described in the 17 September leadership notes.
