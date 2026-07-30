/* eslint-disable */
// AUTO-GENERATED — DO NOT EDIT
// Run migrations to regenerate.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      gold_m1_bars: {
        Row: {
          close: number
          high: number
          id: number
          low: number
          open: number
          timestamp: string
          volume: number | null
        }
        Insert: {
          close: number
          high: number
          id?: never
          low: number
          open: number
          timestamp: string
          volume?: number | null
        }
        Update: {
          close?: number
          high?: number
          id?: never
          low?: number
          open?: number
          timestamp?: string
          volume?: number | null
        }
        Relationships: []
      }
      shadow_signals_v1: {
        Row: {
          id: number
          signal_id: string
          created_at: string
          direction: string
          entry: number
          sl: number
          tp1: number
          tp2: number
          tp3: number
          confidence: number
          entry_shifted: number
          sl_shifted: number
          tp1_shifted: number
          tp2_shifted: number
          tp3_shifted: number
          sl_multiplier: number
          atr: number
          regime: string
          session_name: string
          hour_utc: number
          sr_zones_snapshot: Json | null
          attention_scores: Json | null
          htf_trend: string | null
          ltf_trend: string | null
          rsi: number | null
          feature_schema_version: number
        }
        Insert: {
          id?: never
          signal_id: string
          created_at?: string
          direction?: string
          entry: number
          sl: number
          tp1: number
          tp2: number
          tp3: number
          confidence: number
          entry_shifted: number
          sl_shifted: number
          tp1_shifted: number
          tp2_shifted: number
          tp3_shifted: number
          sl_multiplier: number
          atr: number
          regime: string
          session_name: string
          hour_utc: number
          sr_zones_snapshot?: Json | null
          attention_scores?: Json | null
          htf_trend?: string | null
          ltf_trend?: string | null
          rsi?: number | null
          feature_schema_version?: number
        }
        Update: {
          id?: never
          signal_id?: string
          created_at?: string
          direction?: string
          entry?: number
          sl?: number
          tp1?: number
          tp2?: number
          tp3?: number
          confidence?: number
          entry_shifted?: number
          sl_shifted?: number
          tp1_shifted?: number
          tp2_shifted?: number
          tp3_shifted?: number
          sl_multiplier?: number
          atr?: number
          regime?: string
          session_name?: string
          hour_utc?: number
          sr_zones_snapshot?: Json | null
          attention_scores?: Json | null
          htf_trend?: string | null
          ltf_trend?: string | null
          rsi?: number | null
          feature_schema_version?: number
        }
        Relationships: []
      }
      sr_zones_v1: {
        Row: {
          confluence_score: number
          first_seen_ts: string
          id: number
          last_touch_ts: string | null
          price: number
          reaction_strength: number
          rejection_wicks: number
          source: string
          touches: number
          type: string
          updated_at: string
        }
        Insert: {
          confluence_score?: number
          first_seen_ts?: string
          id?: never
          last_touch_ts?: string | null
          price: number
          reaction_strength?: number
          rejection_wicks?: number
          source: string
          touches?: number
          type: string
          updated_at?: string
        }
        Update: {
          confluence_score?: number
          first_seen_ts?: string
          id?: never
          last_touch_ts?: string | null
          price?: number
          reaction_strength?: number
          rejection_wicks?: number
          source?: string
          touches?: number
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      trade_outcomes_v1: {
        Row: {
          confidence: number | null
          created_at: string
          device_id: string | null
          direction: string | null
          entry_price: number
          exit_price: number
          feature_schema_version: number
          features: Json
          is_scratch: boolean | null
          misleading_features: Json | null
          pnl: number
          realized_r: number | null
          result: string
          signal_duration_ms: number | null
          signal_id: string
          ts: string
          updated_at: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          device_id?: string | null
          direction?: string | null
          entry_price: number
          exit_price: number
          feature_schema_version?: number
          features?: Json
          is_scratch?: boolean | null
          misleading_features?: Json | null
          pnl: number
          realized_r?: number | null
          result: string
          signal_duration_ms?: number | null
          signal_id: string
          ts: string
          updated_at?: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          device_id?: string | null
          direction?: string | null
          entry_price?: number
          exit_price?: number
          feature_schema_version?: number
          features?: Json
          is_scratch?: boolean | null
          misleading_features?: Json | null
          pnl?: number
          realized_r?: number | null
          result?: string
          signal_duration_ms?: number | null
          signal_id?: string
          ts?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
