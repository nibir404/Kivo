import { Text, View } from "react-native"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../lib/api"

export default function Home() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.get("/users/me") })
  return (
    <View style={{ flex: 1, padding: 24 }}>
      <Text style={{ fontSize: 28, fontWeight: "600" }}>Hi {me?.display_name ?? "there"}</Text>
    </View>
  )
}
