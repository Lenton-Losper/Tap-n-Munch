"use client"

import { useState } from "react"
import { RefreshCw, Clock, ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type OrderStatus = "new" | "preparing" | "ready" | "done"

interface Order {
  id: string
  table: number
  timeAgo: string
  total: number
  status: OrderStatus
  items: {
    quantity: number
    name: string
    customizations?: string
  }[]
  specialInstructions?: string
}

const orders: Order[] = [
  {
    id: "#1234",
    table: 7,
    timeAgo: "2m ago",
    total: 340,
    status: "new",
    items: [
      { quantity: 2, name: "Grilled Salmon", customizations: "Large, Extra Sauce" },
      { quantity: 1, name: "Caesar Salad" },
    ],
    specialInstructions: "No onions please, allergic to garlic",
  },
  {
    id: "#1235",
    table: 3,
    timeAgo: "5m ago",
    total: 225,
    status: "new",
    items: [
      { quantity: 1, name: "Beef Burger", customizations: "No pickles" },
      { quantity: 2, name: "Mango Smoothie" },
    ],
  },
  {
    id: "#1236",
    table: 12,
    timeAgo: "8m ago",
    total: 180,
    status: "new",
    items: [
      { quantity: 3, name: "Bruschetta" },
      { quantity: 1, name: "Chocolate Lava Cake" },
    ],
  },
  {
    id: "#1231",
    table: 5,
    timeAgo: "12m ago",
    total: 420,
    status: "preparing",
    items: [
      { quantity: 2, name: "Grilled Salmon", customizations: "Regular" },
      { quantity: 2, name: "Beef Burger" },
    ],
  },
  {
    id: "#1232",
    table: 8,
    timeAgo: "15m ago",
    total: 195,
    status: "preparing",
    items: [
      { quantity: 1, name: "Caesar Salad", customizations: "Side Salad" },
      { quantity: 2, name: "Drinks" },
    ],
  },
  {
    id: "#1228",
    table: 2,
    timeAgo: "20m ago",
    total: 310,
    status: "ready",
    items: [
      { quantity: 1, name: "Beef Burger", customizations: "Large, Extra Sauce" },
      { quantity: 2, name: "Mango Smoothie" },
    ],
  },
]

const tabs: { id: OrderStatus; label: string; count: number }[] = [
  { id: "new", label: "New", count: 3 },
  { id: "preparing", label: "Preparing", count: 5 },
  { id: "ready", label: "Ready", count: 2 },
  { id: "done", label: "Done", count: 0 },
]

export function OrdersDashboard() {
  const [activeTab, setActiveTab] = useState<OrderStatus>("new")

  const filteredOrders = orders.filter((order) => order.status === activeTab)

  const getStatusColor = (status: OrderStatus) => {
    switch (status) {
      case "new":
        return "border-primary"
      case "preparing":
        return "border-blue-500"
      case "ready":
        return "border-green-500"
      default:
        return "border-border"
    }
  }

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <header className="bg-card border-b border-border">
        <div className="container mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => window.history.back()} className="h-11 w-11">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-3xl font-bold">Live Orders</h1>
          </div>
          <Button variant="outline" size="icon">
            <RefreshCw className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="bg-card border-b border-border">
        <div className="container mx-auto px-6">
          <div className="flex gap-8">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="relative py-4 text-sm font-medium transition-colors hover:text-primary"
              >
                <span className={activeTab === tab.id ? "text-primary" : "text-muted-foreground"}>
                  {tab.label} ({tab.count})
                </span>
                {activeTab === tab.id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Orders List */}
      <div className="container mx-auto px-6 py-6">
        <div className="grid gap-4 lg:grid-cols-2">
          {filteredOrders.map((order) => (
            <div
              key={order.id}
              className={cn("bg-card border-2 rounded-lg p-6 space-y-4", getStatusColor(order.status))}
            >
              {/* Order Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold">{order.id}</span>
                  <Badge variant="secondary">Table {order.table}</Badge>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  {order.timeAgo}
                </div>
                <span className="text-lg font-bold">N${order.total}</span>
              </div>

              {/* Order Items */}
              <div className="space-y-2">
                {order.items.map((item, index) => (
                  <div key={index} className="text-sm">
                    <span className="font-medium">
                      {item.quantity}x {item.name}
                    </span>
                    {item.customizations && <span className="text-muted-foreground ml-2">({item.customizations})</span>}
                  </div>
                ))}
              </div>

              {/* Special Instructions */}
              {order.specialInstructions && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
                  <p className="text-sm text-yellow-900 font-medium">Special Instructions:</p>
                  <p className="text-sm text-yellow-800">{order.specialInstructions}</p>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 pt-2">
                <Button variant="outline" className="flex-1 bg-transparent">
                  Decline
                </Button>
                <Button className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground">
                  Accept & Start
                </Button>
              </div>
            </div>
          ))}
        </div>

        {filteredOrders.length === 0 && (
          <div className="text-center py-12">
            <p className="text-muted-foreground text-lg">No {activeTab} orders</p>
          </div>
        )}
      </div>
    </div>
  )
}
