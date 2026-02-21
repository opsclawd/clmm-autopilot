use anchor_lang::prelude::*;

declare_id!("A81Xsuwg5zrT1sgvkncemfWqQ8nymwHS3e7ExM4YnXMm");

#[program]
pub mod receipt {
    use super::*;

    // Placeholder instruction so the program builds + tests run.
    pub fn noop(_ctx: Context<Noop>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Noop {}
