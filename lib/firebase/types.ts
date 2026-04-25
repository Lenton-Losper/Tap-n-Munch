// Complete database schema types

export interface User {
  id: string // Firebase Auth UID
  email: string
  name: string
  phone: string
  role: 'owner' | 'manager' | 'staff'
  restaurant_id?: string // FK to restaurants.id
  created_at: string
  last_login: string
}

export interface Restaurant {
  id: string
  owner_id: string // FK to users.id
  owner_uid: string // Firebase Auth UID (for Storage rules)
  name: string
  slug: string // URL-friendly: "flash-tap"
  description: string
  email: string
  phone: string
  address: string
  logo_url: string | null
  primary_color: string // "#FF6B35"
  currency: string // "NAD"
  timezone: string // "Africa/Windhoek"
  online_ordering_enabled: boolean
  payment_methods: string[] // ["cash", "card", "mobile"]
  tax_rate: number // 0.15 for 15% VAT
  service_fee: number
  subscription_tier: 'starter' | 'professional' | 'enterprise'
  subscription_status: 'active' | 'inactive' | 'trial'
  finatic_merchant_no?: string
  finatic_store_no?: string
  finatic_terminal_sn?: string
  created_at: string
  updated_at: string
}

// Legacy Category interface (deprecated - use MenuCategory)
export interface Category {
  id: string
  restaurant_id: string // FK to restaurants.id
  name: string // "Starters", "Mains", "Drinks"
  display_order: number // For sorting
  active: boolean
  created_at: string
}

// NEW: Menu Category (Top level: "Drinks", "Food", "Specials")
export interface MenuCategory {
  id: string
  restaurant_id: string // FK to restaurants.id
  name: string // "Drinks", "Food", "Specials"
  description: string | null
  display_order: number // For sorting
  active: boolean
  created_at: string
  updated_at: string
}

// NEW: Sub Category (Second level: "Alcoholic drinks", "Soft drinks", etc.)
export interface SubCategory {
  id: string
  restaurant_id: string // FK to restaurants.id
  menu_category_id: string // FK to menu_categories.id
  name: string // "Alcoholic drinks", "Soft drinks", etc.
  description: string | null
  display_order: number
  active: boolean
  created_at: string
  updated_at: string
}

export interface MenuItemSize {
  name: string // "Small", "Regular", "Large"
  price_modifier: number // -20, 0, +25
}

export interface MenuItemAddon {
  name: string // "Extra Sauce"
  price: number // 15
}

export interface MenuItemVariant {
  size: string // "S", "M", "L"
  label: string // "Small", "Medium", "Large"
  price: number // absolute price for the variant
}

export interface MenuItemVariantGroup {
  name: string
  required: boolean
  type: 'text' | 'price'
  options: Array<string | { label: string; price: number }>
}

export interface MenuItem {
  id: string
  restaurant_id: string // FK to restaurants.id
  menu_category_id: string // FK to menu_categories.id (denormalized for quick filtering)
  sub_category_id: string // FK to sub_categories.id (primary parent)
  // Legacy field for backward compatibility during migration
  category_id?: string // FK to categories.id (deprecated)
  name: string
  description: string
  image_url: string | null
  base_price: number
  variants?: MenuItemVariant[]
  variantGroups?: MenuItemVariantGroup[]
  
  // Image display options
  imageFit?: 'contain' | 'cover' | 'fill' | 'scale-down' // How the image should be displayed
  imagePosition?: 'center' | 'top' | 'bottom' // Image alignment within container
  
  // Customizations
  has_sizes: boolean
  sizes: MenuItemSize[]
  has_addons: boolean
  addons: MenuItemAddon[]
  allow_special_instructions: boolean
  
  // Availability
  status: 'available' | 'out_of_stock' | 'hidden'
  
  // Analytics
  times_ordered: number
  total_revenue: number
  
  created_at: string
  updated_at: string
}

export interface Table {
  id: string
  restaurant_id: string // FK to restaurants.id
  table_number: number
  table_name: string // "Table 7" or "Patio Table 3"
  location: string | null // "Main Dining Area"
  qr_code_url: string // "https://app.com/menu/rest_id?table=7"
  qr_code_image: string // Storage URL
  active: boolean
  created_at: string
}

export interface OrderItem {
  menu_item_id: string
  name: string
  quantity: number
  base_price: number
  selected_size: { name: string; price_modifier: number } | null
  selected_addons: Array<{ name: string; price: number }>
  special_instructions: string
  subtotal: number
}

export interface Order {
  id: string
  order_number: number // Sequential per restaurant
  restaurant_id: string // FK to restaurants.id
  table_id: string | null // FK to tables.id
  table_number: number
  
  // Customer info (required) - NEW SCHEMA: nested object
  customer: {
    name: string
    phone: string
  }
  
  // Order items
  items: OrderItem[]
  
  order_instructions: string | null
  
  // Pricing
  subtotal: number
  tax: number
  service_fee: number
  discount: number
  tip: number
  total: number
  
  // Payment
  payment_method: 'cash' | 'card' | 'mobile_money'
  /** Finatic: hosted checkout URL flow vs physical terminal vs cash (null). */
  payment_channel: 'hosted' | 'terminal' | null
  payment_status: 'pending' | 'cash_pending' | 'paid' | 'failed'
  paid_at: string | null
  /** When staff marked the order ready to push/settle on the card terminal. */
  ready_for_terminal_at?: string
  /** When a terminal push was requested (future terminal integration). */
  terminal_push_requested_at?: string
  
  // Order lifecycle
  status:
    | 'new'
    | 'accepted'
    | 'preparing'
    | 'ready'
    | 'ready_for_terminal'
    | 'completed'
    | 'cancelled'
  table_closed: boolean // PART 1: Track if table is closed (prevents order leakage)
  
  // Timestamps
  placed_at: string
  accepted_at: string | null
  preparing_at: string | null
  ready_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  
  prep_time_minutes: number | null
  
  created_at: string
  updated_at: string
}

export interface AnalyticsDaily {
  id: string // "analytics_2025-01-25_rest_abc123"
  restaurant_id: string
  date: string // "2025-01-25"
  total_orders: number
  total_revenue: number
  total_tax: number
  total_tips: number
  new_customers: number
  returning_customers: number
  avg_order_value: number
  avg_prep_time_minutes: number
  top_items: Array<{
    item_id: string
    name: string
    orders: number
    revenue: number
  }>
  peak_hours: Array<{
    hour: number
    orders: number
  }>
  payment_breakdown?: {
    cash_orders: number
    card_orders: number
    cash_revenue: number
    card_revenue: number
  }
}

