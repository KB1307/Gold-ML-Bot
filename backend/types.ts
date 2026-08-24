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
      app_m1_bars: {
        Row: {
          close: number
          created_at: string
          high: number
          id: number
          low: number
          open: number
          source: string
          timestamp: string
        }
        Insert: {
          close: number
          created_at?: string
          high: number
          id?: number
          low: number
          open: number
          source?: string
          timestamp: string
        }
        Update: {
          close?: number
          created_at?: string
          high?: number
          id?: number
          low?: number
          open?: number
          source?: string
          timestamp?: string
        }
        Relationships: []
      }
      emitted_signals_v1: {
        Row: {
          atr: number | null
          attention_scores: Json | null
          confidence: number
          created_at: string
          direction: string
          driving_zone_touches: number | null
          emitted_at: string
          entry: number
          feature_schema_version: number
          hour_utc: number | null
          htf_trend: string | null
          id: number
          ltf_trend: string | null
          nearest_opp_zone_behind_entry_dist_atr: number | null
          nearest_opp_zone_behind_entry_price: number | null
          nearest_opp_zone_behind_entry_type: string | null
          raw_confidence: number | null
          regime: string | null
          rsi: number | null
          session_name: string | null
          signal_id: string
          sl: number
          sl_multiplier: number | null
          source: string
          sr_zones_snapshot: Json | null
          strength_diff: number | null
          tp1: number
          tp2: number
          tp3: number
          zone_map_age_minutes: number | null
        }
        Insert: {
          atr?: number | null
          attention_scores?: Json | null
          confidence: number
          created_at?: string
          direction: string
          driving_zone_touches?: number | null
          emitted_at: string
          entry: number
          feature_schema_version?: number
          hour_utc?: number | null
          htf_trend?: string | null
          id?: number
          ltf_trend?: string | null
          nearest_opp_zone_behind_entry_dist_atr?: number | null
          nearest_opp_zone_behind_entry_price?: number | null
          nearest_opp_zone_behind_entry_type?: string | null
          raw_confidence?: number | null
          regime?: string | null
          rsi?: number | null
          session_name?: string | null
          signal_id: string
          sl: number
          sl_multiplier?: number | null
          source?: string
          sr_zones_snapshot?: Json | null
          strength_diff?: number | null
          tp1: number
          tp2: number
          tp3: number
          zone_map_age_minutes?: number | null
        }
        Update: {
          atr?: number | null
          attention_scores?: Json | null
          confidence?: number
          created_at?: string
          direction?: string
          driving_zone_touches?: number | null
          emitted_at?: string
          entry?: number
          feature_schema_version?: number
          hour_utc?: number | null
          htf_trend?: string | null
          id?: number
          ltf_trend?: string | null
          nearest_opp_zone_behind_entry_dist_atr?: number | null
          nearest_opp_zone_behind_entry_price?: number | null
          nearest_opp_zone_behind_entry_type?: string | null
          raw_confidence?: number | null
          regime?: string | null
          rsi?: number | null
          session_name?: string | null
          signal_id?: string
          sl?: number
          sl_multiplier?: number | null
          source?: string
          sr_zones_snapshot?: Json | null
          strength_diff?: number | null
          tp1?: number
          tp2?: number
          tp3?: number
          zone_map_age_minutes?: number | null
        }
        Relationships: []
      }
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
      pipeline_health_v1: {
        Row: {
          checked_at: string
          cron_lag_minutes: number | null
          detail: Json
          failures: Json
          id: number
          last_cron_success_at: string | null
          non200_count: number
          status: string
          window_hours: number
        }
        Insert: {
          checked_at?: string
          cron_lag_minutes?: number | null
          detail?: Json
          failures?: Json
          id?: never
          last_cron_success_at?: string | null
          non200_count?: number
          status: string
          window_hours?: number
        }
        Update: {
          checked_at?: string
          cron_lag_minutes?: number | null
          detail?: Json
          failures?: Json
          id?: never
          last_cron_success_at?: string | null
          non200_count?: number
          status?: string
          window_hours?: number
        }
        Relationships: []
      }
      shadow_signals_v1: {
        Row: {
          atr: number
          attention_scores: Json | null
          confidence: number
          created_at: string
          direction: string
          entry: number
          entry_shifted: number
          feature_schema_version: number
          hour_utc: number
          htf_trend: string | null
          id: number
          ltf_trend: string | null
          regime: string
          rsi: number | null
          session_name: string
          signal_id: string
          sl: number
          sl_multiplier: number
          sl_shifted: number
          sr_zones_snapshot: Json | null
          tp1: number
          tp1_shifted: number
          tp2: number
          tp2_shifted: number
          tp3: number
          tp3_shifted: number
        }
        Insert: {
          atr: number
          attention_scores?: Json | null
          confidence: number
          created_at?: string
          direction?: string
          entry: number
          entry_shifted: number
          feature_schema_version?: number
          hour_utc: number
          htf_trend?: string | null
          id?: number
          ltf_trend?: string | null
          regime: string
          rsi?: number | null
          session_name: string
          signal_id: string
          sl: number
          sl_multiplier: number
          sl_shifted: number
          sr_zones_snapshot?: Json | null
          tp1: number
          tp1_shifted: number
          tp2: number
          tp2_shifted: number
          tp3: number
          tp3_shifted: number
        }
        Update: {
          atr?: number
          attention_scores?: Json | null
          confidence?: number
          created_at?: string
          direction?: string
          entry?: number
          entry_shifted?: number
          feature_schema_version?: number
          hour_utc?: number
          htf_trend?: string | null
          id?: number
          ltf_trend?: string | null
          regime?: string
          rsi?: number | null
          session_name?: string
          signal_id?: string
          sl?: number
          sl_multiplier?: number
          sl_shifted?: number
          sr_zones_snapshot?: Json | null
          tp1?: number
          tp1_shifted?: number
          tp2?: number
          tp2_shifted?: number
          tp3?: number
          tp3_shifted?: number
        }
        Relationships: []
      }
      sr_zones_v1: {
        Row: {
          confluence_score: number
          entry_edge_price: number | null
          first_seen_ts: string
          id: number
          last_touch_ts: string | null
          legacy_reaction_strength: number | null
          legacy_type: string | null
          price: number
          reaction_strength: number
          rejection_wicks: number
          rejections_from_above: number | null
          rejections_from_below: number | null
          source: string
          strength_price: number | null
          touches: number
          type: string
          updated_at: string
        }
        Insert: {
          confluence_score?: number
          entry_edge_price?: number | null
          first_seen_ts?: string
          id?: never
          last_touch_ts?: string | null
          legacy_reaction_strength?: number | null
          legacy_type?: string | null
          price: number
          reaction_strength?: number
          rejection_wicks?: number
          rejections_from_above?: number | null
          rejections_from_below?: number | null
          source: string
          strength_price?: number | null
          touches?: number
          type: string
          updated_at?: string
        }
        Update: {
          confluence_score?: number
          entry_edge_price?: number | null
          first_seen_ts?: string
          id?: never
          last_touch_ts?: string | null
          legacy_reaction_strength?: number | null
          legacy_type?: string | null
          price?: number
          reaction_strength?: number
          rejection_wicks?: number
          rejections_from_above?: number | null
          rejections_from_below?: number | null
          source?: string
          strength_price?: number | null
          touches?: number
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      telegram_outbox_v1: {
        Row: {
          attempts: number
          created_at: string
          delivered_at: string | null
          delivered_on_retry: boolean
          expires_at: string
          id: number
          kind: string
          last_error: string | null
          message: string
          next_attempt_at: string
          parse_mode: string | null
          signal_id: string | null
          status: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          delivered_at?: string | null
          delivered_on_retry?: boolean
          expires_at?: string
          id?: number
          kind?: string
          last_error?: string | null
          message: string
          next_attempt_at?: string
          parse_mode?: string | null
          signal_id?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          delivered_at?: string | null
          delivered_on_retry?: boolean
          expires_at?: string
          id?: number
          kind?: string
          last_error?: string | null
          message?: string
          next_attempt_at?: string
          parse_mode?: string | null
          signal_id?: string | null
          status?: string
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
      check_bar_freshness: { Args: never; Returns: Json }
      get_pipeline_health: { Args: { p_window_hours?: number }; Returns: Json }
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
