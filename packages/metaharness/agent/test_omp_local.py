from __future__ import annotations

import unittest
from types import MethodType, SimpleNamespace

from omp_local import OmpLocal


class OmpLocalConfigPathTest(unittest.IsolatedAsyncioTestCase):
    async def test_gateway_configuration_is_written_to_aura_and_omp_config_directories(self) -> None:
        agent = OmpLocal.__new__(OmpLocal)
        agent._models_yaml_path = ""
        agent._gateway_providers = ["openai-codex"]
        agent._gateway_url = "http://host.docker.internal:4000"
        agent._gateway_token = "no-auth-dummy"
        agent._web_search = False
        commands: list[str] = []

        async def capture_command(self, environment, *, command, **kwargs):
            commands.append(command)
            return SimpleNamespace(stdout="")

        agent.exec_as_agent = MethodType(capture_command, agent)

        await agent._write_models_yaml(SimpleNamespace())
        await agent._write_config(SimpleNamespace())

        self.assertTrue(
            any('"$HOME/.aura/agent/models.yml"' in command for command in commands)
        )
        self.assertTrue(
            any('"$HOME/.aura/agent/config.yml"' in command for command in commands)
        )
        self.assertTrue(
            any('"$HOME/.omp/agent/models.yml"' in command for command in commands)
        )
        self.assertTrue(
            any('"$HOME/.omp/agent/config.yml"' in command for command in commands)
        )


if __name__ == "__main__":
    unittest.main()
