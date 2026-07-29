import { isMain } from "../util";

import "./app";
import "./os";
import "./network";
import "./update";
import "./im";
import "./nimsys";

if (isMain) {
  // Only main window uses player
  import("./audioplayer");
  import("./audioeffect");
  import("./player");
}
