/**
 * Condensed WCAG 2.0 reference for token-efficient LLM prompts.
 * Used for Section 508 compliance which references WCAG 2.0 Level AA.
 * Contains criteria names and levels only - LLMs already know WCAG well.
 */
export const WCAG_2_0_CONDENSED = `
## WCAG 2.0 Quick Reference (Section 508 Standard)

**Note**: Section 508 (revised 2017) incorporates WCAG 2.0 Level AA by reference.

### Principle 1: Perceivable
| Criterion | Title | Level |
|-----------|-------|-------|
| 1.1.1 | Non-text Content | A |
| 1.2.1 | Audio-only and Video-only (Prerecorded) | A |
| 1.2.2 | Captions (Prerecorded) | A |
| 1.2.3 | Audio Description or Media Alternative | A |
| 1.2.4 | Captions (Live) | AA |
| 1.2.5 | Audio Description (Prerecorded) | AA |
| 1.3.1 | Info and Relationships | A |
| 1.3.2 | Meaningful Sequence | A |
| 1.3.3 | Sensory Characteristics | A |
| 1.4.1 | Use of Color | A |
| 1.4.2 | Audio Control | A |
| 1.4.3 | Contrast (Minimum) | AA |
| 1.4.4 | Resize Text | AA |
| 1.4.5 | Images of Text | AA |

### Principle 2: Operable
| Criterion | Title | Level |
|-----------|-------|-------|
| 2.1.1 | Keyboard | A |
| 2.1.2 | No Keyboard Trap | A |
| 2.2.1 | Timing Adjustable | A |
| 2.2.2 | Pause, Stop, Hide | A |
| 2.3.1 | Three Flashes or Below Threshold | A |
| 2.4.1 | Bypass Blocks | A |
| 2.4.2 | Page Titled | A |
| 2.4.3 | Focus Order | A |
| 2.4.4 | Link Purpose (In Context) | A |
| 2.4.5 | Multiple Ways | AA |
| 2.4.6 | Headings and Labels | AA |
| 2.4.7 | Focus Visible | AA |

### Principle 3: Understandable
| Criterion | Title | Level |
|-----------|-------|-------|
| 3.1.1 | Language of Page | A |
| 3.1.2 | Language of Parts | AA |
| 3.2.1 | On Focus | A |
| 3.2.2 | On Input | A |
| 3.2.3 | Consistent Navigation | AA |
| 3.2.4 | Consistent Identification | AA |
| 3.3.1 | Error Identification | A |
| 3.3.2 | Labels or Instructions | A |
| 3.3.3 | Error Suggestion | AA |
| 3.3.4 | Error Prevention (Legal, Financial, Data) | AA |

### Principle 4: Robust
| Criterion | Title | Level |
|-----------|-------|-------|
| 4.1.1 | Parsing | A |
| 4.1.2 | Name, Role, Value | A |

### Key Requirements
- **Contrast**: Normal text 4.5:1 (AA), Large text 3:1 (AA)
- **Large text**: 18pt+ (24px+) or 14pt+ bold (18.66px+)
- **Focus indicators**: Must be visible
- **Keyboard access**: All functionality must be available via keyboard
`;
