import AppNavigator from './src/navigation/AppNavigator';
import {useTerminalHeartbeat} from './src/lib/useTerminalHeartbeat';

export default function App() {
  /**
   * At the root so it outlives every screen — see useTerminalHeartbeat's docblock. This used to be
   * an effect inside OrdersScreen, which meant a till parked anywhere else never reported its
   * version (#373).
   */
  useTerminalHeartbeat();
  return <AppNavigator />;
}
