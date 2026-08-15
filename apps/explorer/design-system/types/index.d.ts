import * as React from 'react';

export interface BadgeProps {
  /** accent = our own / primary; solid = verified; outline = neutral tag; unknown = unattributed */
  variant?: 'accent' | 'solid' | 'outline' | 'unknown';
  children?: React.ReactNode;
}
export declare function Badge(props: BadgeProps): JSX.Element;

/** @startingPoint section="Controls" subtitle="Mono uppercase rectangular button" viewport="700x220" */
export interface ButtonProps {
  /** 'default' | 'accent' | 'solid' | 'ghost' */
  variant?: 'default' | 'accent' | 'solid' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  /** selected/toggled state: inverts to solid ink */
  active?: boolean;
  disabled?: boolean;
  children?: React.ReactNode;
  onClick?: () => void;
}
export declare function Button(props: ButtonProps): JSX.Element;

export interface InputProps {
  placeholder?: string;
  value?: string;
  /** error state: accent border */
  error?: boolean;
  onChange?: (e: any) => void;
  onKeyDown?: (e: any) => void;
  style?: React.CSSProperties;
}
export declare function Input(props: InputProps): JSX.Element;

export interface PanelProps {
  /** optional uppercase mono header band */
  title?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Panel(props: PanelProps): JSX.Element;

export interface StatBlockProps {
  /** uppercase mono label, snake_case allowed (e.g. PAYMENTS_INDEXED) */
  label: React.ReactNode;
  value: React.ReactNode;
  /** small muted suffix next to the value */
  hint?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  style?: React.CSSProperties;
}
export declare function StatBlock(props: StatBlockProps): JSX.Element;
