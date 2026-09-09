# Group Canvas

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vanilla TypeScript, HTML Canvas, Vite, Node, and Socket.io. The implementation brief fixes these choices.

## Product Purpose

A shared whiteboard for drawing together in real time. Participants open the same room URL, choose a brush or eraser, and see one another's work and cursors immediately. Undo and redo apply to the whole room.

## Users

People sketching and exchanging ideas together. More specific audience segmentation is undecided.

## Capabilities and Constraints

Brush colors and widths, eraser, connected participant presence, global history, room URLs, reconnect and snapshot recovery. The board is 1600 × 900 and is fitted in the available area. State lives in server memory. No authentication, persistence, framework, drawing library, or paid service dependency.

## Brand Commitments

Approved direction: friendly, polished, colorful, canvas first. Warm white canvas, rounded floating tools, bright drawing colors, colorful collaborator chips, compact toolbar. The craft references are Excalidraw and tldraw. Identity: “Group Canvas”; supporting line: “a little space for big ideas”. No dashboard and no fake sample drawing or presence.

## Accessibility

Labeled controls, visible keyboard focus, selected states, keyboard shortcuts, touch targets, responsive layout, reduced motion support, truthful connection feedback. Drawing is a visual interaction; this MVP does not provide nonvisual stroke authoring.
